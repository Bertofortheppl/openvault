import { ItemView, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { SkillV2Info, V2Event } from '@opencode-ai/sdk/v2/client';
import type OpenVaultPlugin from '../main';
import { errorText } from './client';
import { TurnReducer, type TurnCallbacks, type TurnResult } from './events';
import { isNearBottom, renderMarkdown, scrollToBottom } from './render';
import type {
  AgentMode,
  ChatMessage,
  PermissionRequest,
  QuestionRequest,
  ServerStatus,
} from './types';
import { uid } from './types';

export const VIEW_TYPE = 'openvault-view';

interface StreamBubble {
  wrap: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
}

export class OpenVaultView extends ItemView {
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private versionEl!: HTMLElement;
  private modeEl!: HTMLElement;
  private skillMenuEl!: HTMLElement;
  private skillChipEl!: HTMLElement;
  private messages: ChatMessage[] = [];
  private mode: AgentMode = 'build';
  private activeSkill: SkillV2Info | null = null;
  private skills: SkillV2Info[] = [];
  private skillMatches: SkillV2Info[] = [];
  private skillIndex = 0;
  private skillsLoaded = false;
  private slashIndex = 0;
  private reducer: TurnReducer | null = null;
  private bubble: StreamBubble | null = null;
  private permissionEl: HTMLElement | null = null;
  private questionEl: HTMLElement | null = null;
  private streaming = false;
  private historyLoaded = false;
  private raf = 0;
  private pendingText = '';
  private pinned = true;
  private stopTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OpenVaultPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'OpenVault';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('ov-root');
    this.buildHeader();
    this.messagesEl = this.contentEl.createEl('div', { cls: 'ov-messages' });
    this.messagesEl.addEventListener('scroll', () => {
      this.pinned = isNearBottom(this.messagesEl);
    });
    this.buildComposer();
    this.refreshStatus(this.plugin.status);
    this.updateComposer();
    await this.loadHistory();
  }

  async onClose(): Promise<void> {
    if (this.raf) window.cancelAnimationFrame(this.raf);
    if (this.stopTimer) window.clearTimeout(this.stopTimer);
    this.raf = 0;
    this.stopTimer = null;
  }

  refreshStatus(status: ServerStatus): void {
    if (!this.statusEl) return;
    const ready = status.state === 'ready';
    if (!ready) this.historyLoaded = false;
    this.statusEl.toggleClass('ov-status--up', ready);
    this.statusEl.toggleClass('ov-status--down', !ready);
    setIcon(this.statusEl, ready ? 'zap' : 'zap-off');
    this.statusEl.setAttribute('aria-label', this.statusLabel(status));
    this.versionEl.setText(
      status.state === 'ready'
        ? status.version
          ? `v${status.version}`
          : 'connected'
        : status.state === 'starting'
          ? 'starting'
          : status.message ?? '',
    );
    this.updateComposer();
    if (ready) void this.loadHistory();
  }

  async loadHistory(): Promise<void> {
    if (this.historyLoaded || !this.plugin.client) return;
    this.historyLoaded = true;
    this.messages = await this.plugin.session.history();
    this.renderMessages();
    this.scrollBottom(true);
  }

  async newConversation(): Promise<void> {
    await this.stop();
    if (this.stopTimer) window.clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.reducer = null;
    this.bubble = null;
    this.streaming = false;
    this.plugin.session.reset();
    await this.plugin.saveSessionState(null);
    this.messages = [];
    this.historyLoaded = true;
    this.permissionEl = null;
    this.questionEl = null;
    this.messagesEl.empty();
    this.updateComposer();
    this.inputEl.focus();
  }

  private statusLabel(status: ServerStatus): string {
    switch (status.state) {
      case 'ready':
        return 'Connected. Click to reconnect.';
      case 'starting':
        return 'Starting opencode server.';
      case 'error':
        return `Server error: ${status.message ?? 'unknown'}. Click to retry.`;
      default:
        return 'Server stopped. Click to start.';
    }
  }

  private buildHeader(): void {
    const header = this.contentEl.createEl('div', { cls: 'ov-header' });
    const left = header.createEl('div', { cls: 'ov-header-left' });
    this.statusEl = left.createEl('span', { cls: 'ov-status ov-status--down' });
    setIcon(this.statusEl, 'zap-off');
    this.statusEl.addEventListener('click', () => void this.plugin.connect());
    left.createEl('span', { cls: 'ov-title', text: 'OpenVault' });
    this.versionEl = left.createEl('span', { cls: 'ov-version' });

    const right = header.createEl('div', { cls: 'ov-header-right' });
    this.modeEl = right.createEl('span', {
      cls: 'ov-mode-badge build',
      text: 'build',
    });
    this.modeEl.addEventListener('click', () => void this.toggleMode());

    const newBtn = right.createEl('button', {
      cls: 'ov-icon-btn',
      attr: { 'aria-label': 'New conversation' },
    });
    setIcon(newBtn, 'plus');
    newBtn.addEventListener('click', () => void this.newConversation());
  }

  private async toggleMode(): Promise<void> {
    this.mode = this.mode === 'build' ? 'plan' : 'build';
    this.modeEl.setText(this.mode);
    this.modeEl.toggleClass('build', this.mode === 'build');
    this.modeEl.toggleClass('plan', this.mode === 'plan');
    await this.plugin.session.setAgent(this.mode);
  }

  private buildComposer(): void {
    const area = this.contentEl.createEl('div', { cls: 'ov-input-area' });
    this.skillMenuEl = area.createEl('div', { cls: 'ov-skill-menu ov-hidden' });
    this.skillChipEl = area.createEl('div', { cls: 'ov-skill-chip ov-hidden' });

    this.inputEl = area.createEl('textarea', {
      cls: 'ov-textarea',
      attr: {
        placeholder: 'Ask opencode...  (Enter to send, Shift+Enter for newline, / for skills)',
        rows: '3',
      },
    });
    this.inputEl.addEventListener('input', () => this.handleInput());
    this.inputEl.addEventListener('keydown', (event) => this.handleKeydown(event));

    const row = area.createEl('div', { cls: 'ov-btn-row' });
    row.createEl('div', { cls: 'ov-spacer' });
    this.stopBtn = row.createEl('button', {
      cls: 'ov-btn ov-btn--danger ov-hidden',
      text: 'Stop',
    });
    this.stopBtn.addEventListener('click', () => void this.stop());
    this.sendBtn = row.createEl('button', {
      cls: 'ov-btn ov-btn--primary',
      text: 'Send',
    });
    this.sendBtn.addEventListener('click', () => void this.send());
  }

  private updateComposer(): void {
    if (!this.inputEl) return;
    const ready =
      this.plugin.status.state === 'ready' && this.plugin.client !== null;
    this.inputEl.disabled = this.streaming || !ready;
    this.sendBtn.disabled = this.streaming || !ready;
    this.stopBtn.toggleClass('ov-hidden', !this.streaming);
  }

  private handleKeydown(event: KeyboardEvent): void {
    const menuOpen = !this.skillMenuEl.hasClass('ov-hidden');
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      this.hideSkillMenu();
      return;
    }
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveSkill(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const skill = this.skillMatches[this.skillIndex];
        if (skill) this.selectSkill(skill);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }

  private handleInput(): void {
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
    if (!match) {
      this.hideSkillMenu();
      return;
    }
    this.slashIndex = before.lastIndexOf('/');
    void this.showSkillMenu(match[1] ?? '');
  }

  private async showSkillMenu(query: string): Promise<void> {
    if (!this.plugin.client) return;
    if (!this.skillsLoaded) {
      this.skillsLoaded = true;
      try {
        const result = await this.plugin.client.v2.skill.list({
          location: { directory: this.plugin.vaultPath },
        });
        this.skills = result.data?.data ?? [];
      } catch {
        this.skills = [];
        this.skillsLoaded = false;
      }
    }

    const needle = query.toLowerCase();
    this.skillMatches = this.skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        (skill.description ?? '').toLowerCase().includes(needle),
    );
    this.skillIndex = 0;
    this.skillMenuEl.empty();

    if (this.skillMatches.length === 0) {
      this.skillMenuEl.createEl('div', {
        cls: 'ov-skill-note',
        text: 'No matching skills.',
      });
    } else {
      this.skillMatches.forEach((skill, index) => {
        const item = this.skillMenuEl.createEl('div', {
          cls: 'ov-skill-item',
        });
        item.toggleClass('is-selected', index === 0);
        item.createEl('span', { cls: 'ov-skill-name', text: skill.name });
        if (skill.description) {
          item.createEl('span', {
            cls: 'ov-skill-desc',
            text: skill.description,
          });
        }
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          this.selectSkill(skill);
        });
      });
    }
    this.skillMenuEl.removeClass('ov-hidden');
  }

  private moveSkill(delta: number): void {
    if (this.skillMatches.length === 0) return;
    this.skillIndex =
      (this.skillIndex + delta + this.skillMatches.length) %
      this.skillMatches.length;
    const items = Array.from(
      this.skillMenuEl.querySelectorAll<HTMLElement>('.ov-skill-item'),
    );
    items.forEach((item, index) =>
      item.toggleClass('is-selected', index === this.skillIndex),
    );
  }

  private selectSkill(skill: SkillV2Info): void {
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    this.inputEl.value = value.slice(0, this.slashIndex) + value.slice(cursor);
    this.inputEl.setSelectionRange(this.slashIndex, this.slashIndex);
    this.activeSkill = skill;
    this.renderSkillChip();
    this.hideSkillMenu();
    this.inputEl.focus();
  }

  private renderSkillChip(): void {
    this.skillChipEl.empty();
    if (!this.activeSkill) {
      this.skillChipEl.addClass('ov-hidden');
      return;
    }
    this.skillChipEl.removeClass('ov-hidden');
    this.skillChipEl.createSpan({ text: `Skill: ${this.activeSkill.name}` });
    const clear = this.skillChipEl.createEl('span', {
      cls: 'ov-skill-clear',
      text: 'x',
    });
    clear.addEventListener('click', () => {
      this.activeSkill = null;
      this.renderSkillChip();
    });
  }

  private hideSkillMenu(): void {
    this.skillMenuEl?.addClass('ov-hidden');
  }

  private async send(): Promise<void> {
    if (this.streaming) return;
    const raw = this.inputEl.value.trim();
    if (!raw) return;
    if (!this.plugin.client || this.plugin.status.state !== 'ready') {
      new Notice('OpenVault: server is not ready');
      return;
    }

    this.permissionEl?.remove();
    this.permissionEl = null;

    const skill = this.activeSkill;
    let text = this.buildPrompt(raw);
    if (skill) {
      text = `Use the "${skill.name}" skill before answering.\n\n${text}`;
    }

    this.inputEl.value = '';
    this.activeSkill = null;
    this.renderSkillChip();
    this.hideSkillMenu();
    this.pushMessage({
      id: uid(),
      role: 'user',
      text: raw,
      ts: Date.now(),
    });
    this.beginStreaming();

    try {
      const sessionId = await this.plugin.session.ensure(this.mode);
      const callbacks: TurnCallbacks = {
        onText: (value) => this.handleText(value),
        onStatus: (value) => this.handleStatus(value),
        onPermission: (request) => this.renderPermission(request),
        onQuestion: (request) => this.renderQuestion(request),
        onSettled: (result) => this.handleSettled(result),
      };
      const reducer = new TurnReducer(sessionId, callbacks);
      this.reducer = reducer;
      reducer.begin();
      const activeSession = await this.plugin.session.prompt(
        text,
        this.mode,
        (id) => reducer.rebind(id),
      );
      if (activeSession !== sessionId) reducer.rebind(activeSession);
      await this.plugin.saveSessionState(activeSession);
    } catch (error) {
      this.handleSettled({
        text: this.pendingText,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildPrompt(text: string): string {
    if (!this.plugin.settings.injectContext) return text;
    const file = this.app.workspace.getActiveFile();
    const selection =
      this.app.workspace.activeEditor?.editor?.getSelection()?.trim() ?? '';
    if (!file && !selection) return text;

    const parts: string[] = [];
    if (file) parts.push(`Current file: [[${file.path}]]`);
    if (selection) parts.push(`Selected text:\n\`\`\`\n${selection}\n\`\`\``);
    return `<context>\n${parts.join('\n')}\n</context>\n\n${text}`;
  }

  private beginStreaming(): void {
    this.streaming = true;
    this.pendingText = '';
    this.updateComposer();

    const wrap = this.messagesEl.createEl('div', {
      cls: 'ov-msg ov-msg--assistant',
    });
    const bubble = wrap.createEl('div', { cls: 'ov-bubble' });
    const body = bubble.createEl('div', { cls: 'ov-body' });
    const status = bubble.createEl('div', {
      cls: 'ov-tool-status',
      text: 'Waiting for opencode...',
    });
    this.bubble = { wrap, body, status };
    this.scrollBottom(true);
  }

  private handleText(text: string): void {
    this.pendingText = text;
    if (this.raf) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.bubble) return;
      this.bubble.status.addClass('ov-hidden');
      this.bubble.body.setText(this.pendingText);
      if (this.pinned) scrollToBottom(this.messagesEl);
    });
  }

  private handleStatus(text: string): void {
    if (!this.bubble) return;
    this.bubble.status.setText(text);
    this.bubble.status.toggleClass('ov-hidden', !text);
  }

  private handleSettled(result: TurnResult): void {
    if (!this.streaming && !this.bubble) return;
    if (this.stopTimer) window.clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.permissionEl?.remove();
    this.permissionEl = null;
    this.questionEl?.remove();
    this.questionEl = null;

    const bubble = this.bubble;
    if (bubble) {
      bubble.status.remove();
      bubble.wrap.addClass('ov-settled');
      if (result.text.trim()) {
        renderMarkdown(
          this.app,
          bubble.body,
          result.text,
          this.sourcePath(),
          this,
        );
      }
      if (result.error) {
        bubble.body.createEl('div', {
          cls: 'ov-error-text',
          text: result.error,
        });
      } else if (!result.text.trim()) {
        bubble.body.createEl('em', { text: '(empty response)' });
      }
    }

    this.messages.push({
      id: uid(),
      role: 'assistant',
      text: result.text,
      ts: Date.now(),
      ...(result.error ? { error: result.error, partial: true } : {}),
    });

    this.streaming = false;
    this.reducer = null;
    this.bubble = null;
    this.pendingText = '';
    this.updateComposer();
    this.scrollBottom(false);
  }

  private renderPermission(request: PermissionRequest): void {
    this.permissionEl?.remove();
    const card = this.messagesEl.createEl('div', { cls: 'ov-permission' });
    this.permissionEl = card;
    card.createEl('div', {
      cls: 'ov-permission-title',
      text: `${request.action} permission requested`,
    });
    if (request.resources.length > 0) {
      card.createEl('div', {
        cls: 'ov-permission-detail',
        text: request.resources.join('\n'),
      });
    }

    const actions = card.createEl('div', { cls: 'ov-permission-actions' });
    const reply = async (value: 'once' | 'always' | 'reject'): Promise<void> => {
      if (!this.plugin.client) return;
      const sessionId = this.plugin.session.sessionId;
      if (!sessionId) return;
      const result = await this.plugin.client.v2.session.permission.reply({
        sessionID: sessionId,
        requestID: request.id,
        reply: value,
      });
      if (result.error) {
        new Notice(`OpenVault: ${errorText(result.error, 'permission failed')}`);
        return;
      }
      card.remove();
      if (this.permissionEl === card) this.permissionEl = null;
    };

    actions.createEl('button', { cls: 'ov-btn ov-btn--primary', text: 'Allow once' })
      .addEventListener('click', () => void reply('once'));
    actions.createEl('button', { cls: 'ov-btn', text: 'Always' })
      .addEventListener('click', () => void reply('always'));
    actions.createEl('button', { cls: 'ov-btn ov-btn--danger', text: 'Reject' })
      .addEventListener('click', () => void reply('reject'));

    this.scrollBottom(false);
  }

  private renderQuestion(request: QuestionRequest): void {
    this.questionEl?.remove();
    const card = this.messagesEl.createEl('div', { cls: 'ov-question' });
    this.questionEl = card;

    const selections = request.questions.map(() => new Set<string>());
    const customs = request.questions.map(() => '');
    const optionContainers: HTMLElement[] = [];
    let submit: HTMLButtonElement | null = null;

    const isAnswered = (index: number): boolean =>
      selections[index].size > 0 ||
      (request.questions[index].custom === true &&
        customs[index].trim().length > 0);

    const sync = (): void => {
      optionContainers.forEach((container, index) => {
        container
          .querySelectorAll<HTMLElement>('.ov-question-option')
          .forEach((item) =>
            item.toggleClass(
              'is-selected',
              selections[index].has(item.dataset.label ?? ''),
            ),
          );
      });
      if (submit) {
        submit.disabled = !request.questions.every((_, index) =>
          isAnswered(index),
        );
      }
    };

    request.questions.forEach((question, index) => {
      card.createEl('div', {
        cls: 'ov-question-header',
        text: question.header,
      });
      card.createEl('div', {
        cls: 'ov-question-text',
        text: question.question,
      });

      const optionsEl = card.createEl('div', { cls: 'ov-question-options' });
      optionContainers.push(optionsEl);

      let customEl: HTMLInputElement | null = null;
      if (question.custom) {
        customEl = card.createEl('input', {
          cls: 'ov-question-custom',
          attr: { type: 'text', placeholder: 'Type your own answer' },
        });
        customEl.addEventListener('input', () => {
          customs[index] = customEl?.value ?? '';
          if (!question.multiple && customs[index].trim()) {
            selections[index].clear();
          }
          sync();
        });
      }

      for (const option of question.options) {
        const item = optionsEl.createEl('button', {
          cls: 'ov-question-option',
        });
        item.dataset.label = option.label;
        item.createEl('span', {
          cls: 'ov-question-option-label',
          text: option.label,
        });
        if (option.description) {
          item.createEl('span', {
            cls: 'ov-question-option-desc',
            text: option.description,
          });
        }
        item.addEventListener('click', () => {
          if (question.multiple) {
            if (selections[index].has(option.label)) {
              selections[index].delete(option.label);
            } else {
              selections[index].add(option.label);
            }
          } else {
            selections[index].clear();
            selections[index].add(option.label);
            if (customEl) customEl.value = '';
            customs[index] = '';
          }
          sync();
        });
      }
    });

    const answer = async (): Promise<void> => {
      if (!this.plugin.client) return;
      const sessionId = this.plugin.session.sessionId;
      if (!sessionId) return;
      const answers = request.questions.map((question, index) => {
        const values = [...selections[index]];
        const custom = customs[index].trim();
        if (question.custom && custom) values.push(custom);
        return values;
      });
      if (answers.some((values) => values.length === 0)) return;
      const result = await this.plugin.client.v2.session.question.reply({
        sessionID: sessionId,
        requestID: request.id,
        questionV2Reply: { answers },
      });
      if (result.error) {
        new Notice(
          `OpenVault: ${errorText(result.error, 'question reply failed')}`,
        );
        return;
      }
      card.remove();
      if (this.questionEl === card) this.questionEl = null;
    };

    const reject = async (): Promise<void> => {
      if (!this.plugin.client) return;
      const sessionId = this.plugin.session.sessionId;
      if (!sessionId) return;
      const result = await this.plugin.client.v2.session.question.reject({
        sessionID: sessionId,
        requestID: request.id,
      });
      if (result.error) {
        new Notice(
          `OpenVault: ${errorText(result.error, 'question reject failed')}`,
        );
        return;
      }
      card.remove();
      if (this.questionEl === card) this.questionEl = null;
    };

    const actions = card.createEl('div', { cls: 'ov-question-actions' });
    submit = actions.createEl('button', {
      cls: 'ov-btn ov-btn--primary',
      text: 'Send answer',
    });
    submit.disabled = true;
    submit.addEventListener('click', () => void answer());
    actions
      .createEl('button', { cls: 'ov-btn', text: 'Skip' })
      .addEventListener('click', () => void reject());

    sync();
    this.scrollBottom(false);
  }

  private async stop(): Promise<void> {
    if (!this.streaming) return;
    this.handleStatus('Stopping...');
    try {
      await this.plugin.session.interrupt();
    } catch {
      // The turn may already have finished.
    }
    if (this.stopTimer) window.clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => {
      this.stopTimer = null;
      if (this.reducer) {
        this.reducer.settle();
      } else {
        this.handleSettled({ text: this.pendingText, aborted: true });
      }
    }, 2500);
  }

  private pushMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.renderMessage(message);
    this.scrollBottom(false);
  }

  private renderMessages(): void {
    this.messagesEl.empty();
    for (const message of this.messages) this.renderMessage(message);
  }

  private renderMessage(message: ChatMessage): void {
    const wrap = this.messagesEl.createEl('div', {
      cls: `ov-msg ov-msg--${message.role}`,
    });
    const bubble = wrap.createEl('div', { cls: 'ov-bubble ov-settled' });

    if (message.role === 'user') {
      bubble.createEl('span', { text: message.text });
      return;
    }

    if (message.text.trim()) {
      renderMarkdown(this.app, bubble, message.text, this.sourcePath(), this);
    }
    if (message.error) {
      bubble.createEl('div', {
        cls: 'ov-error-text',
        text: message.error,
      });
    } else if (!message.text.trim()) {
      bubble.createEl('em', { text: '(empty response)' });
    }
  }

  private sourcePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? '';
  }

  private scrollBottom(force: boolean): void {
    if (force) this.pinned = true;
    if (force || this.pinned) {
      scrollToBottom(this.messagesEl);
    }
  }

  handleEvent(event: V2Event): void {
    this.reducer?.handle(event);
  }
}
