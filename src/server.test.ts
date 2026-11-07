import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeServer } from './server';

const live = new Set<number>();
const dirs = new Set<string>();

afterEach(() => {
  for (const pid of live) {
    try {
      if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
      else process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        continue;
      }
    }
  }
  live.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openvault-test-'));
  dirs.add(dir);
  return dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function track(pid: number | undefined): number {
  if (pid) live.add(pid);
  return pid ?? 0;
}

describe('OpenCodeServer lifecycle', () => {
  it.skipIf(process.platform !== 'linux')(
    'cleans up a stale server recorded by a previous run',
    async () => {
      const dir = tempDir();
      const recordPath = join(dir, 'server.json');
      const child = spawn(
        'bash',
        [
          '-c',
          'exec -a "opencode serve --hostname 127.0.0.1 --port 12345" sleep 30',
        ],
        { stdio: 'ignore' },
      );
      const pid = track(child.pid);
      writeFileSync(recordPath, JSON.stringify({ pid, port: 12345 }));

      const server = new OpenCodeServer('/test-vault', recordPath);
      await server.cleanupStale();
      await waitForExit(pid);

      expect(isAlive(pid)).toBe(false);
      expect(existsSync(recordPath)).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'does not kill an unrelated process from a stale record',
    async () => {
      const dir = tempDir();
      const recordPath = join(dir, 'server.json');
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      const pid = track(child.pid);
      writeFileSync(recordPath, JSON.stringify({ pid, port: 12345 }));

      const server = new OpenCodeServer('/test-vault', recordPath);
      await server.cleanupStale();

      expect(isAlive(pid)).toBe(true);
      expect(existsSync(recordPath)).toBe(false);
    },
  );

  it('refuses to start after killNow', async () => {
    const server = new OpenCodeServer(
      '/test-vault',
      join(tempDir(), 'server.json'),
    );
    server.killNow();

    await expect(server.start('/bin/true', tmpdir())).rejects.toThrow(
      'server stopped',
    );
  });

  it('does not spawn when killed during startup', async () => {
    const server = new OpenCodeServer(
      '/test-vault',
      join(tempDir(), 'server.json'),
    );
    const starting = server.start('/bin/true', tmpdir());
    server.killNow();

    await expect(starting).rejects.toThrow('server stopped');
  });

  it.skipIf(process.platform === 'win32')(
    'killNow kills the whole process group',
    async () => {
      const child = spawn(
        'bash',
        ['-c', 'sleep 30 & echo $!; wait'],
        { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
      );
      const pid = track(child.pid);
      const grandchild = await new Promise<number>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(
          () => reject(new Error('no grandchild pid')),
          2000,
        );
        child.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const match = out.match(/(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      track(grandchild);

      const server = new OpenCodeServer(
        '/test-vault',
        join(tempDir(), 'server.json'),
      );
      (server as unknown as { proc: ChildProcess }).proc = child;
      server.killNow();

      await waitForExit(pid);
      await waitForExit(grandchild);

      expect(isAlive(pid)).toBe(false);
      expect(isAlive(grandchild)).toBe(false);
    },
  );

  it('kills a process spawned during an aborted start', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'pid');
    const script = join(dir, 'fake-opencode');
    writeFileSync(
      script,
      `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 30\n`,
      { mode: 0o755 },
    );

    const recordPath = join(dir, 'server.json');
    const server = new OpenCodeServer('/test-vault', recordPath);
    const starting = server.start(script, dir);

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !existsSync(pidFile)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(pidFile)).toBe(true);
    const pid = track(Number(readFileSync(pidFile, 'utf8').trim()));

    server.killNow();
    await expect(starting).rejects.toThrow();
    await waitForExit(pid);

    expect(isAlive(pid)).toBe(false);
    expect(existsSync(recordPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'stop escalates from SIGTERM to SIGKILL',
    async () => {
      const dir = tempDir();
      const script = join(dir, 'ignore-term');
      const ready = join(dir, 'ready');
      writeFileSync(
        script,
        `#!/bin/bash\ntrap "" TERM\necho ready > "${ready}"\nwhile :; do sleep 1; done\n`,
        { mode: 0o755 },
      );
      const child = spawn(script, [], {
        stdio: 'ignore',
        detached: true,
      });
      const pid = track(child.pid);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !existsSync(ready)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(ready)).toBe(true);

      const server = new OpenCodeServer(
        '/test-vault',
        join(dir, 'server.json'),
      );
      (server as unknown as { proc: ChildProcess }).proc = child;
      server.stop();

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(isAlive(pid)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(isAlive(pid)).toBe(false);
    },
    10000,
  );

  it('killNow kills the tracked process immediately', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { stdio: 'ignore' },
    );
    const pid = track(child.pid);

    const server = new OpenCodeServer(
      '/test-vault',
      join(tempDir(), 'server.json'),
    );
    (server as unknown as { proc: ChildProcess }).proc = child;
    server.killNow();
    await waitForExit(pid);

    expect(isAlive(pid)).toBe(false);
  });
});
