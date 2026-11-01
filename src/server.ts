import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerStatus } from './types';

const ORIGIN = 'app://obsidian.md';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => {
        if (port) resolve(port);
        else reject(new Error('could not allocate a local port'));
      });
    });
  });
}

export function resolveBinary(configured: string): string {
  const value = configured.trim();
  if (value) return value;

  const candidates = [
    process.env.OPENCODE_BIN,
    join(homedir(), '.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'opencode';
}

export class OpenCodeServer {
  private proc: ChildProcess | null = null;
  private port = 0;
  private status: ServerStatus = { state: 'stopped' };
  private readonly listeners = new Set<(status: ServerStatus) => void>();
  private stderr = '';

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get current(): ServerStatus {
    return this.status;
  }

  onStatus(fn: (status: ServerStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private setStatus(status: ServerStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  async start(configuredBinary: string, cwd: string): Promise<string> {
    if (this.proc) return this.baseUrl;

    const binary = resolveBinary(configuredBinary);
    this.port = await findFreePort();
    this.stderr = '';
    this.setStatus({ state: 'starting' });

    const proc = spawn(
      binary,
      [
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(this.port),
        '--cors',
        ORIGIN,
      ],
      {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    this.proc = proc;

    proc.stdout?.on('data', (chunk: Buffer) => {
      console.debug('[OpenVault]', chunk.toString().trim());
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    proc.on('error', (err: Error) => {
      this.proc = null;
      this.setStatus({ state: 'error', message: err.message });
    });
    proc.on('exit', (code: number | null) => {
      this.proc = null;
      if (this.status.state !== 'stopped') {
        this.setStatus({
          state: 'error',
          message: this.stderr.trim() || `server exited (${code ?? 'unknown'})`,
        });
      }
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(this.stderr.trim() || 'server exited before ready');
      if (await this.healthy()) {
        const version = await this.readVersion();
        this.setStatus({ state: 'ready', version });
        return this.baseUrl;
      }
      await sleep(250);
    }

    this.stop();
    throw new Error(this.stderr.trim() || 'server did not become ready in 15s');
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        signal: timeoutSignal(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async readVersion(): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/global/health`, {
        signal: timeoutSignal(1000),
      });
      if (!res.ok) return '';
      const body = (await res.json()) as { version?: string };
      return body.version ?? '';
    } catch {
      return '';
    }
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.kill('SIGTERM');
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2500);
      proc.once('exit', () => clearTimeout(timer));
    }
    this.setStatus({ state: 'stopped' });
  }
}
