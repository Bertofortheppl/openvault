import {
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerStatus } from './types';

const ORIGIN = 'app://obsidian.md';

type ServerRecord = { pid: number; port: number };

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
  private stopping: ChildProcess | null = null;
  private port = 0;
  private status: ServerStatus = { state: 'stopped' };
  private readonly listeners = new Set<(status: ServerStatus) => void>();
  private stderr = '';
  private readonly statePath: string;
  private closedFlag = false;

  constructor(vaultPath: string, statePath?: string) {
    const key = createHash('sha1').update(vaultPath).digest('hex').slice(0, 12);
    this.statePath =
      statePath ?? join(tmpdir(), 'openvault', `${key}.json`);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get current(): ServerStatus {
    return this.status;
  }

  get closed(): boolean {
    return this.closedFlag;
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

  async cleanupStale(): Promise<void> {
    const record = this.readRecord();
    if (!record) return;

    if (!this.isAlive(record.pid)) {
      this.clearRecord();
      return;
    }
    if (!(await this.looksLikeServer(record.pid, record.port))) {
      this.clearRecord();
      return;
    }

    const killed = this.killPid(record.pid, 'SIGKILL');
    if (killed || !this.isAlive(record.pid)) {
      console.debug('[OpenVault] cleaned up a stale server');
      this.clearRecord();
    }
  }

  async start(configuredBinary: string, cwd: string): Promise<string> {
    if (this.closedFlag) throw new Error('server stopped');
    if (this.proc) return this.baseUrl;

    await this.cleanupStale();
    if (this.closedFlag) throw new Error('server stopped');

    const binary = resolveBinary(configuredBinary);
    this.port = await findFreePort();
    if (this.closedFlag) throw new Error('server stopped');
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
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );

    this.proc = proc;
    if (proc.pid) this.writeRecord({ pid: proc.pid, port: this.port });

    proc.stdout?.on('data', (chunk: Buffer) => {
      console.debug('[OpenVault]', chunk.toString().trim());
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    proc.on('error', (err: Error) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.clearRecord(proc.pid);
      this.setStatus({ state: 'error', message: err.message });
    });
    proc.on('exit', (code: number | null) => {
      const wasCurrent = this.proc === proc;
      if (wasCurrent) this.proc = null;
      if (this.stopping === proc) this.stopping = null;
      this.clearRecord(proc.pid);
      if (wasCurrent && this.status.state !== 'stopped') {
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
      this.stopping = proc;
      this.signal(proc, 'SIGTERM');
      const timer = setTimeout(() => this.signal(proc, 'SIGKILL'), 2500);
      proc.once('exit', () => {
        clearTimeout(timer);
        if (this.stopping === proc) this.stopping = null;
      });
    }
    this.setStatus({ state: 'stopped' });
  }

  killNow(): void {
    this.closedFlag = true;
    const procs = [this.proc, this.stopping];
    this.proc = null;
    this.stopping = null;
    for (const proc of procs) {
      if (proc) this.signal(proc, 'SIGKILL');
    }
    if (procs.some(Boolean)) this.clearRecord();
    this.setStatus({ state: 'stopped' });
  }

  private signal(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.pid) this.killPid(proc.pid, signal);
  }

  private killPid(pid: number, signal: NodeJS.Signals): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (process.platform === 'win32') {
      const result = spawnSync(
        'taskkill',
        ['/pid', String(pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true },
      );
      if (result.status === 0) return true;
      try {
        process.kill(pid, 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    }
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async looksLikeServer(pid: number, port: number): Promise<boolean> {
    if (process.platform === 'linux') {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        return (
          cmdline.includes('opencode') &&
          cmdline.includes('serve') &&
          cmdline.includes(String(port))
        );
      } catch {
        return this.looksLikeServerOverHttp(port);
      }
    }
    return this.looksLikeServerOverHttp(port);
  }

  private async looksLikeServerOverHttp(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
        signal: timeoutSignal(1000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { version?: string };
      return Boolean(body.version);
    } catch {
      return false;
    }
  }

  private readRecord(): ServerRecord | null {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as ServerRecord;
      if (
        Number.isInteger(raw.pid) &&
        raw.pid > 0 &&
        Number.isInteger(raw.port) &&
        raw.port > 0 &&
        raw.port < 65536
      ) {
        return raw;
      }
    } catch {
      return null;
    }
    return null;
  }

  private writeRecord(record: ServerRecord): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(record));
    } catch (error) {
      console.warn('[OpenVault] could not write server record', error);
    }
  }

  private clearRecord(pid?: number): void {
    if (pid !== undefined) {
      const record = this.readRecord();
      if (record && record.pid !== pid) return;
    }
    try {
      unlinkSync(this.statePath);
    } catch {
      return;
    }
  }
}
