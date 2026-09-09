import * as fs from 'node:fs/promises';

// A PID can be reused. On Linux, boot ID plus the kernel's start-time ticks
// distinguish the original owner from a later process assigned the same PID.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
export async function getProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const [stat, bootId] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    // comm, field 2, is parenthesized and can itself contain spaces or ')'.
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fields[19]; // field 22, with field 3 at index 0
    const boot = bootId.trim();
    if (!/^\d+$/.test(startTime ?? '') || !/^[0-9a-f-]{36}$/.test(boot)) return null;
    return `linux:${boot}:${startTime}`;
  } catch {
    // Missing procfs, permissions, and unsupported platforms retain the
    // conservative liveness check; lack of identity never proves staleness.
    return null;
  }
}
