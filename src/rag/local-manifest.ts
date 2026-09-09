import * as fs from 'node:fs/promises';

// The Node SDK does not expose a table's external base paths. This read-only
// guard rejects them before optimize can touch a clone's source. It never
// chooses files to delete; LanceDB owns all maintenance.
// Format and field numbers: Lance 4.0.0, used by LanceDB 0.27.2:
// https://github.com/lance-format/lance/blob/v4.0.0/protos/table.proto
// https://github.com/lance-format/lance/blob/v4.0.0/rust/lance-table/src/io/manifest.rs
export async function assertLocalManifest(file: string): Promise<void> {
  const data = await fs.readFile(file);
  const invalid = () => new Error(`Unsupported or corrupt Lance manifest: ${file}. Snapshot preparation supports ordinary local indexes only.`);
  if (data.length < 20 || data.subarray(-4).toString() !== 'LANC' ||
      data.readUInt16LE(data.length - 8) !== 0 || data.readUInt16LE(data.length - 6) !== 2) {
    throw invalid();
  }
  const start = Number(data.readBigUInt64LE(data.length - 16));
  const end = data.length - 16;
  if (!Number.isSafeInteger(start) || start < 0 || start + 4 > end ||
      start + 4 + data.readUInt32LE(start) !== end) throw invalid();
  let position = start + 4;
  function varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (position >= end) throw invalid();
      const byte = data[position++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw invalid();
  }
  while (position < end) {
    const key = Number(varint());
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    // Unknown manifest fields require a compatibility review. In particular,
    // do not silently accept a future mechanism for referring to other data.
    if (field < 1 || field > 21 || field === 17) throw invalid();
    if (field === 18 || field === 20) {
      throw new Error(`Shallow clones, external base paths, and branches are not supported: ${file}`);
    }
    if (wireType === 0) varint();
    else if (wireType === 1) position += 8;
    else if (wireType === 5) position += 4;
    else if (wireType === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length)) throw invalid();
      position += length;
    } else throw invalid();
    if (position > end) throw invalid();
  }
}
