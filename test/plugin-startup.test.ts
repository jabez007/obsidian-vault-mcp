import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('plugin startup scripts', () => {
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
    for (const script of ['claude-mcp-server.sh', 'session-init.sh', 'session-index.mjs']) {
      await fs.copyFile(path.resolve('scripts', script), path.join(root, 'scripts', script));
    }
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
    await fs.writeFile(path.join(root, 'dist/index.js'), `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.CLAUDE_PLUGIN_DATA + '/starts', 'start\\n');
      if (process.env.TEST_STDERR) process.stderr.write(process.env.TEST_STDERR);
      if (process.env.TEST_NOISY) process.stderr.write('x'.repeat(2 * 1024 * 1024));
      process.stdout.write(process.env.TEST_RESULT || '{"success":true,"chunks":0}');
      if (process.argv.includes('--hold')) setInterval(() => {}, 1000);
      else process.exitCode = Number(process.env.TEST_EXIT || 0);
    `);
    await fs.writeFile(path.join(tmp, 'bin', 'npm'), `#!/usr/bin/env bash
set -eu
printf 'install\\n' >> "$CLAUDE_PLUGIN_DATA/calls"
if ! mkdir "$CLAUDE_PLUGIN_DATA/install-active" 2>/dev/null; then
  echo 'concurrent install' >&2
  exit 7
fi
trap 'rmdir "$CLAUDE_PLUGIN_DATA/install-active"' EXIT
while [ ! -f "$CLAUDE_PLUGIN_DATA/release-install" ]; do sleep 0.01; done
if [ "$TEST_INSTALL_FAIL" = 1 ]; then echo 'simulated npm failure' >&2; exit 8; fi
mkdir -p "$CLAUDE_PLUGIN_DATA/node_modules/@lancedb/lancedb"
echo 'npm diagnostic'
`, { mode: 0o755 });
    env = {
      ...process.env,
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data,
      OBSIDIAN_VAULT_PATH: path.join(tmp, 'vault'), OBSIDIAN_MCP_SERVER_COMMAND: '',
      OBSIDIAN_INSTALL_LOCK_WAIT_SECONDS: '2',
      TEST_INSTALL_FAIL: '0',
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

  function launch(script = 'claude-mcp-server.sh', args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
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

  async function waitForFile(name: string) {
    for (let i = 0; i < 200; i++) {
      if (await fs.stat(path.join(data, name)).then(() => true).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${name}`);
  }

  async function releaseInstall() { await fs.writeFile(path.join(data, 'release-install'), ''); }
  async function installCount() { return (await fs.readFile(path.join(data, 'calls'), 'utf8')).trim().split('\n').length; }

  it('serializes cold launches and releases the lock before the first server exits', async () => {
    const first = launch('claude-mcp-server.sh', ['--hold']);
    await waitForFile('calls');
    const second = launch();
    await new Promise(resolve => setTimeout(resolve, 150));
    await releaseInstall();
    const result = await second.done;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);
    expect(await installCount()).toBe(1);
    await waitForFile('starts');
    expect(first.child.exitCode).toBeNull();
    expect((await launch().done).code).toBe(0);
    expect(await installCount()).toBe(1);
  });

  it('does not stamp a failed install and retries successfully', async () => {
    await releaseInstall();
    const failed = await launch('claude-mcp-server.sh', [], { TEST_INSTALL_FAIL: '1' }).done;
    expect(failed.code).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('simulated npm failure');
    await expect(fs.stat(path.join(data, '.install-stamp'))).rejects.toThrow();
    expect((await launch().done).code).toBe(0);
    expect(await installCount()).toBe(2);
  });

  it('reports a bounded lock timeout on stderr', async () => {
    launch();
    await waitForFile('calls');
    const result = await launch('claude-mcp-server.sh', [], { OBSIDIAN_INSTALL_LOCK_WAIT_SECONDS: '0.1' }).done;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Timed out waiting');
    expect(result.stdout).toBe('');
    expect(await installCount()).toBe(1);
  });

  it('recovers after the installing process group dies', async () => {
    const first = launch();
    await waitForFile('install-active');
    process.kill(-first.child.pid!, 'SIGKILL');
    await first.done;
    // The fake npm marker models unpacking state, not the launcher's lock.
    await fs.rmdir(path.join(data, 'install-active'));
    await releaseInstall();
    expect((await launch().done).code).toBe(0);
    expect(await installCount()).toBe(2);
  });

  it('reinstalls when the bundle changes or a required dependency disappears', async () => {
    await releaseInstall();
    expect((await launch().done).code).toBe(0);
    await fs.appendFile(path.join(root, 'dist/index.js'), '\n// updated bundle\n');
    expect((await launch().done).code).toBe(0);
    await fs.rmdir(path.join(data, 'node_modules/@lancedb/lancedb'));
    expect((await launch().done).code).toBe(0);
    expect(await installCount()).toBe(3);
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
    await releaseInstall();
    const result = await launch('session-init.sh', [], { TEST_EXIT: '1', TEST_STDERR: 'index failure' }).done;
    expect(JSON.parse(result.stdout).systemMessage).toContain('Could not save diagnostics');
    expect(result.stderr).toContain('index failure');
  });

  it.each([
    ['process error', '9', 'installation failed', 'raw error output'],
    ['index result error', '0', 'embedding failed', '{"success":false,"chunks":0,"message":"index failed"}'],
    ['invalid result', '0', '', 'not json'],
  ])('records %s with valid hook JSON and a diagnostic log', async (_name, code, stderr, stdout) => {
    await releaseInstall();
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
    await releaseInstall();
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
