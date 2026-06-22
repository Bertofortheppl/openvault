import { Plugin, ItemView, WorkspaceLeaf, PluginSettingTab, App, Setting, Notice } from 'obsidian';
import http from 'http';
import { spawn, ChildProcess } from 'child_process';

const OPENVAULT_VIEW = 'openvault-chat-view';
const DEFAULT_PORT = 4097;

interface OpenVaultSettings {
  port: number;
  openrouterApiKey: string;
  autoStart: boolean;
  opencodePath: string;
}

const DEFAULT_SETTINGS: OpenVaultSettings = {
  port: DEFAULT_PORT,
  openrouterApiKey: '',
  autoStart: false,
  opencodePath: '/home/berto/.opencode/bin/opencode',
};

export default class OpenVaultPlugin extends Plugin {
  settings: OpenVaultSettings;
  serverReady = false;
  private healthPollTimer: number | null = null;
  private serverProcess: ChildProcess | null = null;
  private serverStartAttempted = false;

  async onload() {
    await this.loadSettings();

    this.registerView(OPENVAULT_VIEW, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon('message-square', 'OpenVault', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-openvault',
      name: 'Open OpenVault chat',
      callback: () => this.activateView(),
    });

    this.addSettingTab(new OpenVaultSettingsTab(this.app, this));

    if (this.settings.autoStart && this.settings.openrouterApiKey) {
      this.startServer();
    }

    this.startHealthPoll();
  }

  onunload() {
    this.stopHealthPoll();
    this.stopServer();
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(OPENVAULT_VIEW);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    await this.app.workspace.getRightLeaf(false).setViewState({
      type: OPENVAULT_VIEW,
      active: true,
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  refreshChatViews() {
    this.app.workspace.getLeavesOfType(OPENVAULT_VIEW).forEach(leaf => {
      (leaf.view as ChatView).refreshStatus?.();
    });
  }

  private startServer() {
    if (this.serverProcess) return;
    this.serverStartAttempted = true;

    const vaultPath = (this.app.vault.adapter as any).getBasePath?.() ?? '';
    if (!vaultPath) {
      new Notice('OpenVault: could not determine vault path');
      return;
    }

    const env = { ...process.env };
    if (this.settings.openrouterApiKey) {
      env.OPENROUTER_API_KEY = this.settings.openrouterApiKey;
    }

    const proc = spawn(this.settings.opencodePath, ['serve', '--port', String(this.settings.port)], {
      cwd: vaultPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      new Notice(`OpenVault: server start failed - ${err.message}`);
      this.serverProcess = null;
    });

    proc.on('exit', (code) => {
      if (code !== 0 && this.serverProcess !== null) {
        console.log(`OpenVault server exited with code ${code}`);
      }
      this.serverProcess = null;
    });

    proc.stderr?.on('data', (data: Buffer) => {
      console.log('[OpenVault stderr]', data.toString());
    });

    this.serverProcess = proc;
  }

  private stopServer() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
  }

  private startHealthPoll() {
    this.stopHealthPoll();
    this.healthPollTimer = window.setInterval(async () => {
      const up = await this.checkHealth();
      if (up && !this.serverReady) {
        this.serverReady = true;
        new Notice('OpenVault: connected');
        this.refreshChatViews();
      } else if (!up && this.serverReady) {
        this.serverReady = false;
        this.refreshChatViews();
      }
    }, 10000);
  }

  private stopHealthPoll() {
    if (this.healthPollTimer !== null) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = null;
    }
  }

  private httpRequest(url: string, options?: http.RequestOptions, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'GET', ...options }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await this.httpRequest(`http://127.0.0.1:${this.settings.port}/global/health`);
      return res.status === 200;
    } catch {
      return false;
    }
  }
}

// ── Chat view ────────────────────────────────────────────────────────────────

class ChatView extends ItemView {
  plugin: OpenVaultPlugin;
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  activeSessionId: string | null = null;
  private eventReader: { cancel: () => void } | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: OpenVaultPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return OPENVAULT_VIEW; }
  getDisplayText() { return 'OpenVault'; }
  getIcon() { return 'message-square'; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('openvault-container');

    const header = container.createEl('div', { cls: 'openvault-header' });
    header.createEl('span', { cls: 'openvault-title', text: 'OpenVault' });

    // Store reference so we can update it as server state changes
    this.statusEl = header.createEl('span', {
      cls: 'openvault-status disconnected',
      text: '○ disconnected',
    });
    this.refreshStatus();

    this.messagesEl = container.createEl('div', { cls: 'openvault-messages' });

    const inputRow = container.createEl('div', { cls: 'openvault-input-row' });
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'openvault-input',
      attr: { placeholder: 'Ask opencode...', rows: '3' },
    });
    this.sendBtn = inputRow.createEl('button', {
      cls: 'openvault-send',
      text: 'Send',
    }) as HTMLButtonElement;

    this.sendBtn.addEventListener('click', () => this.sendMessage());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
  }

  async onClose() {
    this.eventReader?.cancel();
    this.eventReader = null;
  }

  // Update the status indicator to reflect current plugin.serverReady state
  refreshStatus() {
    if (!this.statusEl) return;
    const ready = this.plugin.serverReady;
    this.statusEl.className = `openvault-status ${ready ? 'connected' : 'disconnected'}`;
    this.statusEl.setText(ready ? '● connected' : '○ disconnected');
  }

  private setInputEnabled(enabled: boolean) {
    this.inputEl.disabled = !enabled;
    this.sendBtn.disabled = !enabled;
  }

  async sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;

    if (!this.plugin.serverReady) {
      new Notice('OpenVault: server not connected. Start it in your terminal and wait 10s.');
      return;
    }

    this.setInputEnabled(false);
    this.inputEl.value = '';
    this.addMessage('user', text);

    const port = this.plugin.settings.port;

    try {
      // Cancel previous SSE listener to avoid stale connections duplicating deltas
      this.eventReader?.cancel();
      this.eventReader = null;

      // Create session on first message
      if (!this.activeSessionId) {
        const res = await this.plugin.httpRequest(
          `http://127.0.0.1:${port}/session`,
          { method: 'POST' }
        );
        if (res.status !== 200) throw new Error(`Session create failed: ${res.status}`);
        const session = JSON.parse(res.body);
        this.activeSessionId = session.id;
      }

      // Assistant bubble — text span + animated indicator (cursor or thinking dots)
      const assistantEl = this.addMessage('assistant', '');
      const textSpan = assistantEl.createEl('span');
      const indicatorEl = assistantEl.createEl('span', { cls: 'openvault-indicator' });
      // Start with thinking animation
      indicatorEl.createEl('span', { cls: 'openvault-thinking-dot' });
      indicatorEl.createEl('span', { cls: 'openvault-thinking-dot' });
      indicatorEl.createEl('span', { cls: 'openvault-thinking-dot' });
      this.messagesEl.scrollTo(0, this.messagesEl.scrollHeight);

      let accumulatedText = '';
      let hasReceivedContent = false;
      let pauseTimer: number | null = null;

      const showCursor = () => {
        indicatorEl.empty();
        indicatorEl.setText('▍');
      };

      const showThinking = () => {
        indicatorEl.empty();
        indicatorEl.createEl('span', { cls: 'openvault-thinking-dot' });
        indicatorEl.createEl('span', { cls: 'openvault-thinking-dot' });
        indicatorEl.createEl('span', { cls: 'openvault-thinking-dot' });
      };

      const resetPauseTimer = () => {
        if (pauseTimer !== null) {
          clearTimeout(pauseTimer);
        }
        pauseTimer = window.setTimeout(() => {
          // No deltas for 1.5s — show thinking dots to indicate still working
          showThinking();
        }, 1500);
      };

      // Open SSE stream BEFORE sending the prompt — events are push, not pull
      const streamDone = this.listenForResponse(
        this.activeSessionId,
        (delta: string) => {
          if (!hasReceivedContent) {
            hasReceivedContent = true;
          }
          accumulatedText += delta;
          textSpan.setText(accumulatedText);
          showCursor();
          this.messagesEl.scrollTo(0, this.messagesEl.scrollHeight);
          resetPauseTimer();
        },
        () => {
          // Streaming done — render with clickable wiki-links
          if (pauseTimer !== null) clearTimeout(pauseTimer);
          assistantEl.empty();
          if (accumulatedText) {
            this.renderMessage(assistantEl, accumulatedText);
          } else {
            assistantEl.setText('(empty response)');
          }
          this.setInputEnabled(true);
          this.inputEl.focus();
        },
        (errMsg: string) => {
          if (pauseTimer !== null) clearTimeout(pauseTimer);
          assistantEl.empty();
          assistantEl.setText(`Error: ${errMsg}`);
          this.setInputEnabled(true);
        }
      );

      // Fire the prompt — returns 204, response streams via SSE above
      const promptRes = await this.plugin.httpRequest(
        `http://127.0.0.1:${port}/session/${this.activeSessionId}/prompt_async`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ parts: [{ type: 'text', text }] })
      );
      if (promptRes.status !== 204) {
        let msg = `prompt_async failed: ${promptRes.status}`;
        try { const b = JSON.parse(promptRes.body); msg = b?.data?.message ?? msg; } catch {}
        throw new Error(msg);
      }

      await streamDone;
    } catch (err: any) {
      this.addMessage('assistant', `Error: ${err.message}`);
      this.setInputEnabled(true);
    }
  }

  // Subscribe to /global/event SSE bus using Node http module
  private listenForResponse(
    sessionId: string,
    onDelta: (delta: string) => void,
    onDone: () => void,
    onError: (msg: string) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const port = this.plugin.settings.port;
      let aborted = false;

      const finish = (errMsg?: string) => {
        if (aborted) return;
        aborted = true;
        if (errMsg) onError(errMsg);
        else onDone();
        resolve();
      };

      const req = http.get(`http://127.0.0.1:${port}/global/event`, (res) => {
        if (res.statusCode !== 200) {
          finish('SSE connect failed');
          return;
        }

        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              const p = event.payload ?? event;
              const info = p.properties ?? {};
              if (info.sessionID && info.sessionID !== sessionId) continue;

              if (p.type === 'message.part.delta' && info.field === 'text') {
                onDelta(info.delta ?? '');
              } else if (p.type === 'message.part.delta' && info.field === 'reasoning') {
                // reasoning chunks — skip
              } else if (p.type === 'session.idle') {
                finish();
                return;
              } else if (p.type === 'session.error') {
                const msg = info.error?.message ?? info.error?.data?.message ?? 'session error';
                finish(msg);
                return;
              }
            } catch { /* skip malformed lines */ }
          }
        });

        res.on('end', () => finish());
        res.on('error', (err) => finish(err.message));
      });

      req.on('error', (err) => finish(err.message));

      // Allow cancel from outside
      this.eventReader = { cancel: () => { req.destroy(); finish(); } } as any;
    });
  }

  private addMessage(role: string, text: string): HTMLElement {
    const el = this.messagesEl.createEl('div', { cls: `openvault-message openvault-${role}` });
    if (text && role === 'user') {
      this.renderMessage(el, text);
    } else {
      el.setText(text);
    }
    this.messagesEl.scrollTo(0, this.messagesEl.scrollHeight);
    return el;
  }

  // Render text with clickable [[wiki-links]] and markdown-style links
  private renderMessage(el: HTMLElement, text: string) {
    const pattern = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      // Text before this match
      if (match.index > lastIndex) {
        el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[1]) {
        // [[wiki-link]]
        const linkTarget = match[1];
        const a = el.createEl('a', {
          cls: 'internal-link',
          text: linkTarget,
          href: linkTarget,
        });
        a.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.app.workspace.openLinkText(linkTarget, '', false)
            .catch(() => {
              new Notice(`Could not open "${linkTarget}"`);
            });
        });
      } else if (match[2] && match[3]) {
        // [label](url)
        const label = match[2];
        const url = match[3];
        const a = el.createEl('a', {
          cls: 'external-link',
          text: label,
          href: url,
        });
        if (url.startsWith('obsidian://') || url.endsWith('.md')) {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.app.workspace.openLinkText(url, '', false)
              .catch(() => new Notice(`Could not open "${url}"`));
          });
        } else {
          a.setAttr('target', '_blank');
        }
      }

      lastIndex = pattern.lastIndex;
    }

    // Remaining text after last match
    if (lastIndex < text.length) {
      el.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }
}

// ── Settings tab ─────────────────────────────────────────────────────────────

class OpenVaultSettingsTab extends PluginSettingTab {
  plugin: OpenVaultPlugin;

  constructor(app: App, plugin: OpenVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server port')
      .setDesc('Port the opencode server is running on.')
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_PORT))
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            this.plugin.settings.port = parseInt(value) || DEFAULT_PORT;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('OpenRouter API key')
      .setDesc('API key used by opencode.')
      .addText((text) =>
        text
          .setPlaceholder('sk-or-v1-...')
          .setValue(this.plugin.settings.openrouterApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openrouterApiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-start server')
      .setDesc('Start opencode serve automatically when Obsidian opens this vault.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoStart)
          .onChange(async (value) => {
            this.plugin.settings.autoStart = value;
            await this.plugin.saveSettings();
            if (value && this.plugin.settings.openrouterApiKey) {
              this.plugin.startServer();
            } else if (!value) {
              this.plugin.stopServer();
            }
          })
      );

    new Setting(containerEl)
      .setName('opencode path')
      .setDesc('Path to the opencode binary.')
      .addText((text) =>
        text
          .setPlaceholder('/home/berto/.opencode/bin/opencode')
          .setValue(this.plugin.settings.opencodePath)
          .onChange(async (value) => {
            this.plugin.settings.opencodePath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Server status')
      .setDesc(this.plugin.serverReady
        ? 'Connected to opencode on port ' + this.plugin.settings.port
        : 'Not connected. Run opencode serve --port ' + this.plugin.settings.port + ' in a terminal.')
  }
}
