import { FileSystemAdapter, Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import type { V2Event } from '@opencode-ai/sdk/v2/client';
import { createClient, statusOf, type OpencodeClient } from './src/client';
import { ChatSession } from './src/session';
import { OpenCodeServer } from './src/server';
import { OpenVaultSettingsTab } from './src/settings';
import {
  DEFAULT_SETTINGS,
  type OpenVaultSettings,
  type PersistedData,
  type ServerStatus,
} from './src/types';
import { OpenVaultView, VIEW_TYPE } from './src/view';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export default class OpenVaultPlugin extends Plugin {
  settings: OpenVaultSettings = { ...DEFAULT_SETTINGS };
  session!: ChatSession;
  client: OpencodeClient | null = null;
  status: ServerStatus = { state: 'stopped' };
  server!: OpenCodeServer;

  private eventAbort: AbortController | null = null;
  private connectPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  get vaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter
      ? adapter.getBasePath()
      : process.cwd();
  }

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.server = new OpenCodeServer(this.vaultPath);
    await this.server.cleanupStale();
    this.session = new ChatSession(null, this.vaultPath);
    this.session.sessionId = this.storedSessionId;

    this.server.onStatus((status) => {
      this.status = status;
      this.refreshViews();
    });

    this.registerEvent(
      this.app.workspace.on('quit', () => this.server.killNow()),
    );
    this.registerDomEvent(window, 'beforeunload', () =>
      this.server.killNow(),
    );
    const onExit = (): void => this.server.killNow();
    process.on('exit', onExit);
    this.register(() => process.off('exit', onExit));

    this.registerView(
      VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new OpenVaultView(leaf, this),
    );
    this.addRibbonIcon('message-square', 'OpenVault', () => void this.openView());
    this.addCommand({
      id: 'openvault-open',
      name: 'Open OpenVault chat',
      callback: () => void this.openView(),
    });
    this.addCommand({
      id: 'openvault-new-conversation',
      name: 'OpenVault: new conversation',
      callback: () => void this.createConversation(),
    });
    this.addCommand({
      id: 'openvault-reconnect',
      name: 'OpenVault: reconnect',
      callback: () => void this.connect(),
    });
    this.addSettingTab(new OpenVaultSettingsTab(this.app, this));

    if (this.settings.autoStart) {
      this.app.workspace.onLayoutReady(() => void this.connect());
    }
  }

  override onunload(): void {
    this.disposeEvents();
    this.server?.killNow();
  }

  async openView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      await this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async createConversation(): Promise<void> {
    await this.openView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf?.view instanceof OpenVaultView) {
      await leaf.view.newConversation();
    }
  }

  connect(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.disposeEvents();
    this.client = null;
    this.session.setClient(null);
    this.server.stop();

    try {
      await this.server.start(this.settings.opencodePath, this.vaultPath);
    } catch (error) {
      if (this.server.closed) return;
      new Notice(
        `OpenVault: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (this.server.closed) return;

    const client = createClient(this.server.baseUrl);
    this.client = client;
    this.session.setClient(client);
    this.startEvents(client);

    const existing = this.session.sessionId;
    if (existing) {
      try {
        const check = await client.v2.session.get({ sessionID: existing });
        if (statusOf(check) === 404) {
          this.session.reset();
          await this.saveSessionState(null);
        }
      } catch {
        // Keep the stored session and let history report the problem.
      }
    }
    this.refreshViews();
  }

  private startEvents(client: OpencodeClient): void {
    this.disposeEvents();
    const controller = new AbortController();
    this.eventAbort = controller;
    void this.runEvents(client, controller.signal);
  }

  private async runEvents(
    client: OpencodeClient,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const { stream } = await client.v2.event.subscribe({
          signal,
          sseMaxRetryAttempts: 1,
        });
        for await (const event of stream) {
          if (signal.aborted) break;
          this.dispatch(event as V2Event);
        }
      } catch (error) {
        if (!signal.aborted) {
          console.warn('[OpenVault] event stream error', error);
        }
      }
      if (!signal.aborted) await sleep(1000);
    }
  }

  private dispatch(event: V2Event): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof OpenVaultView) leaf.view.handleEvent(event);
    }
  }

  private disposeEvents(): void {
    this.eventAbort?.abort();
    this.eventAbort = null;
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof OpenVaultView) {
        leaf.view.refreshStatus(this.status);
      }
    }
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as
      | (PersistedData & Record<string, unknown>)
      | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };

    if (raw && !raw.settings) {
      if (typeof raw.opencodePath === 'string') {
        this.settings.opencodePath = raw.opencodePath;
      }
      if (typeof raw.autoStart === 'boolean') {
        this.settings.autoStart = raw.autoStart;
      }
      if (typeof raw.injectContext === 'boolean') {
        this.settings.injectContext = raw.injectContext;
      }
    }

    this.storedSessionId =
      typeof raw?.state?.sessionId === 'string' ? raw.state.sessionId : null;
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  async saveSessionState(sessionId: string | null): Promise<void> {
    if (this.session) this.session.sessionId = sessionId;
    await this.persist();
  }

  private storedSessionId: string | null = null;

  private persist(): Promise<void> {
    const data: PersistedData = {
      settings: this.settings,
      state: { sessionId: this.session?.sessionId ?? null },
    };
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.saveData(data))
      .catch((error: unknown) => {
        console.error('[OpenVault] could not save settings', error);
        new Notice('OpenVault: could not save settings');
      });
    return this.writeQueue;
  }
}
