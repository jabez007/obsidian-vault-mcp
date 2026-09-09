#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Drain both streams even after the limit, so noisy installs cannot block.
const maxBytes = 64 * 1024;
let output = Buffer.alloc(0);
let diagnostics = Buffer.alloc(0);
function tail(previous, chunk) {
  return Buffer.concat([previous, chunk]).subarray(-maxBytes);
}

const [command, ...args] = process.argv.slice(2);
const result = await new Promise(resolve => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => {
    output = tail(output, chunk);
    diagnostics = tail(diagnostics, chunk);
  });
  child.stderr.on('data', chunk => { diagnostics = tail(diagnostics, chunk); });
  child.on('error', error => {
    diagnostics = tail(diagnostics, Buffer.from(`\n${error.message}\n`));
  });
  child.on('close', (code, signal) => resolve({ code, signal }));
});

let indexResult;
try { indexResult = JSON.parse(output.toString('utf8')); } catch { /* captured below */ }
if (result.code === 0 && indexResult?.success === true) {
  const chunks = indexResult.chunks;
  process.stdout.write(chunks === 0 ? 'RAG index up to date'
    : Number.isInteger(chunks) && chunks > 0 ? `RAG index updated: ${chunks} chunks indexed`
      : 'RAG index check completed');
} else {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'obsidian-vault-mcp');
  const logDir = path.join(dataDir, 'logs');
  const name = `session-init-${Date.now()}-${randomUUID()}.log`;
  const logPath = path.join(logDir, name);
  // Put the CLI response last: late stderr must not hide success:false details.
  diagnostics = tail(diagnostics, Buffer.from(`\nExit: ${result.code}; signal: ${result.signal ?? 'none'}\nResponse: ${output.toString('utf8')}\n`));
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await writeFile(logPath, diagnostics, { mode: 0o600, flag: 'wx' });
    const logs = (await readdir(logDir)).filter(file => /^session-init-\d+-[\da-f-]+\.log$/.test(file)).sort().reverse();
    await Promise.all(logs.slice(5).map(file => unlink(path.join(logDir, file)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })));
    process.stdout.write(`RAG index refresh failed. Log: ${logPath}`);
  } catch (error) {
    process.stderr.write(`Could not save RAG diagnostics: ${error.message}\n${diagnostics.toString('utf8')}`);
    process.stdout.write('RAG index refresh failed. Could not save diagnostics; see hook stderr.');
  }
}
