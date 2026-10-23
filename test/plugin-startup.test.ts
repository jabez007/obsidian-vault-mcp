import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('plugin session hook', () => {
  let tmp: string;
  let root: string;
  let data: string;
  let env: NodeJS.ProcessEnv;
  let children: ChildProcess[];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin startup '));
    root = path.join(tmp, 'plugin root');
    data = path.join(tmp, 'plugin data');
    children = [];
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(root, 'dist'));
    await fs.mkdir(path.join(tmp, 'bin'));
    await fs.mkdir(path.join(tmp, 'vault'));
    for (const script of ['session-init.sh', 'session-index.mjs']) {
      await fs.copyFile(path.resolve('scripts', script), path.join(root, 'scripts', script));
    }
    await fs.writeFile(path.join(root, 'dist/index.js'), `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.CLAUDE_PLUGIN_DATA + '/starts', 'start\\n');
      if (process.env.TEST_STDERR) process.stderr.write(process.env.TEST_STDERR);
      if (process.env.TEST_NOISY) process.stderr.write('x'.repeat(2 * 1024 * 1024));
      process.stdout.write(process.env.TEST_RESULT || '{"success":true,"chunks":0}');
      process.exitCode = Number(process.env.TEST_EXIT || 0);
    `);
    await fs.mkdir(path.join(root, 'node_modules/@lancedb/lancedb'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'bin', 'npx'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CLAUDE_PLUGIN_DATA/npx"
printf '{"success":true,"chunks":0}'
`, { mode: 0o755 });
    env = {
      ...process.env,
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data,
      OBSIDIAN_VAULT_PATH: path.join(tmp, 'vault'), OBSIDIAN_MCP_SERVER_COMMAND: '',
    };
    await fs.mkdir(data);
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.pid && child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
      }
    }
    await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null)
      .map(c => new Promise(resolve => c.once('close', resolve))));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function launch(script = 'session-init.sh', args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
    const child = spawn('bash', [path.join(root, 'scripts', script), ...args], {
      env: { ...env, ...overrides }, detached: true,
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    return { child, done };
  }

  it('runs the bundled server when the plugin dependencies are installed', async () => {
    const result = await launch().done;
    expect(JSON.parse(result.stdout).systemMessage).toContain('RAG index up to date');
    expect(await fs.readFile(path.join(data, 'starts'), 'utf8')).toBe('start\n');
    await expect(fs.stat(path.join(data, 'npx'))).rejects.toThrow();
  });

  it('falls back to the npm package when the plugin dependencies are missing', async () => {
    await fs.rm(path.join(root, 'node_modules'), { recursive: true });
    const result = await launch().done;
    expect(JSON.parse(result.stdout).systemMessage).toContain('RAG index up to date');
    expect(await fs.readFile(path.join(data, 'npx'), 'utf8')).toBe('-y @jabez007/obsidian-vault-mcp@2 obsidian_rag_index\n');
    await expect(fs.stat(path.join(data, 'starts'))).rejects.toThrow();
  });

  it('uses a writable state directory for non-Claude hooks and records spawn failures', async () => {
    const result = await launch('session-init.sh', [], {
      CLAUDE_PLUGIN_ROOT: '', CLAUDE_PLUGIN_DATA: '', XDG_STATE_HOME: path.join(tmp, 'state'),
      OBSIDIAN_MCP_SERVER_COMMAND: 'nonexistent-obsidian-test-command',
    }).done;
    const message = JSON.parse(result.stdout).systemMessage;
    const logPath = message.match(/Log: (.+)$/m)?.[1];
    expect(logPath).toContain(path.join(tmp, 'state', 'obsidian-vault-mcp'));
    expect(await fs.readFile(logPath!, 'utf8')).toContain('ENOENT');
  });

  it('keeps valid hook JSON when the diagnostic directory cannot be created', async () => {
    await fs.writeFile(path.join(data, 'logs'), 'not a directory');
    const result = await launch('session-init.sh', [], { TEST_EXIT: '1', TEST_STDERR: 'index failure' }).done;
    expect(JSON.parse(result.stdout).systemMessage).toContain('Could not save diagnostics');
    expect(result.stderr).toContain('index failure');
  });

  it.each([
    ['process error', '9', 'installation failed', 'raw error output'],
    ['index result error', '0', 'embedding failed', '{"success":false,"chunks":0,"message":"index failed"}'],
    ['invalid result', '0', '', 'not json'],
  ])('records %s with valid hook JSON and a diagnostic log', async (_name, code, stderr, stdout) => {
    const result = await launch('session-init.sh', [], { TEST_EXIT: code, TEST_STDERR: stderr, TEST_RESULT: stdout }).done;
    expect(result.code).toBe(0);
    const hook = JSON.parse(result.stdout);
    expect(hook.systemMessage).toContain('RAG index refresh failed');
    const logPath = hook.systemMessage.match(/Log: (.+)$/m)?.[1];
    expect(logPath).toBeTruthy();
    const log = await fs.readFile(logPath!, 'utf8');
    expect(log).toContain(stdout);
    if (stderr) expect(log).toContain(stderr);
    expect(hook.hookSpecificOutput.additionalContext).toBe(hook.systemMessage);
  });

  it('retains bounded diagnostics and removes successful invocation logs', async () => {
    for (let i = 0; i < 7; i++) {
      const result = await launch('session-init.sh', [], { TEST_EXIT: '1', TEST_NOISY: '1' }).done;
      expect(JSON.parse(result.stdout).systemMessage).toContain('RAG index refresh failed');
    }
    const logs = await fs.readdir(path.join(data, 'logs'));
    expect(logs.length).toBeLessThanOrEqual(5);
    for (const log of logs) expect((await fs.stat(path.join(data, 'logs', log))).size).toBeLessThanOrEqual(65536);
    const success = await launch('session-init.sh').done;
    expect(JSON.parse(success.stdout).systemMessage).toContain('RAG index up to date');
    expect((await fs.readdir(path.join(data, 'logs'))).length).toBe(logs.length);
  });
});
