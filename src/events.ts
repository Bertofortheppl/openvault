import type {
  PermissionV2Asked,
  QuestionV2Asked,
  V2Event,
} from '@opencode-ai/sdk/v2/client';
import type { PermissionRequest, QuestionRequest } from './types';

export interface TurnResult {
  text: string;
  error?: string;
  aborted?: boolean;
}

export interface TurnCallbacks {
  onText?: (text: string) => void;
  onStatus?: (status: string) => void;
  onPermission?: (permission: PermissionRequest) => void;
  onQuestion?: (question: QuestionRequest) => void;
  onSettled?: (result: TurnResult) => void;
}

function messageOf(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return fallback;
  const value = error as {
    message?: string;
    data?: { message?: string };
  };
  return value.message ?? value.data?.message ?? fallback;
}

function sessionOf(event: V2Event): string | undefined {
  const data = (event as { data?: { sessionID?: string; status?: { type?: string } } }).data;
  return data?.sessionID;
}

export class TurnReducer {
  private readonly seen = new Set<string>();
  private readonly parts = new Map<string, string>();
  private active = false;
  private finished = false;
  private aborted = false;
  private error: string | undefined;
  private permission: PermissionRequest | undefined;
  private question: QuestionRequest | undefined;
  private tool: string | undefined;

  constructor(
    public sessionId: string,
    private readonly callbacks: TurnCallbacks,
  ) {}

  rebind(sessionId: string): void {
    this.sessionId = sessionId;
  }

  begin(): void {
    this.parts.clear();
    this.active = true;
    this.finished = false;
    this.aborted = false;
    this.error = undefined;
    this.permission = undefined;
    this.question = undefined;
    this.tool = undefined;
  }

  get isActive(): boolean {
    return this.active && !this.finished;
  }

  get pendingPermission(): PermissionRequest | undefined {
    return this.permission;
  }

  get pendingQuestion(): QuestionRequest | undefined {
    return this.question;
  }

  get text(): string {
    return [...this.parts.values()].join('\n\n');
  }

  handle(event: V2Event): void {
    if (event.id) {
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);
      if (this.seen.size > 2000) this.seen.clear();
    }

    const sessionId = sessionOf(event);
    if (sessionId && sessionId !== this.sessionId) return;
    if (!sessionId && !this.active) return;

    switch (event.type) {
      case 'session.next.text.started': {
        const data = event.data as { textID: string };
        if (!this.parts.has(data.textID)) this.parts.set(data.textID, '');
        break;
      }
      case 'session.next.text.delta': {
        const data = event.data as { textID: string; delta: string };
        this.parts.set(data.textID, (this.parts.get(data.textID) ?? '') + data.delta);
        this.callbacks.onText?.(this.text);
        break;
      }
      case 'session.next.text.ended': {
        const data = event.data as { textID: string; text: string };
        this.parts.set(data.textID, data.text);
        this.callbacks.onText?.(this.text);
        break;
      }
      case 'session.next.step.failed': {
        const data = event.data as { error: unknown };
        this.error = messageOf(data.error, 'step failed');
        this.callbacks.onStatus?.('');
        // A failed step ends the turn — the server does not emit session.idle
        // after a provider error, so settling here is the only way the UI
        // recovers without hanging on "Waiting for opencode...".
        this.settle();
        break;
      }
      case 'session.next.tool.called': {
        const data = event.data as { tool: string };
        this.tool = data.tool;
        this.callbacks.onStatus?.(`Running ${data.tool}...`);
        break;
      }
      case 'session.next.tool.success':
      case 'session.next.tool.failed': {
        this.tool = undefined;
        this.callbacks.onStatus?.('');
        break;
      }
      case 'permission.v2.asked': {
        const data = event.data as PermissionV2Asked['data'];
        this.permission = {
          id: data.id,
          action: data.action,
          resources: data.resources ?? [],
        };
        this.callbacks.onPermission?.(this.permission);
        break;
      }
      case 'permission.v2.replied': {
        this.permission = undefined;
        break;
      }
      case 'question.v2.asked': {
        const data = event.data as QuestionV2Asked['data'];
        this.question = {
          id: data.id,
          questions: data.questions,
        };
        this.callbacks.onStatus?.('Waiting for your answer...');
        this.callbacks.onQuestion?.(this.question);
        break;
      }
      case 'question.v2.replied':
      case 'question.v2.rejected': {
        this.question = undefined;
        this.callbacks.onStatus?.('');
        break;
      }
      case 'session.error': {
        const data = event.data as { error?: { name?: string } };
        if (data.error?.name === 'MessageAbortedError') {
          this.aborted = true;
        } else {
          this.error = messageOf(data.error, 'session error');
        }
        this.settle();
        break;
      }
      case 'session.status': {
        const data = event.data as { status?: { type?: string } };
        if (data.status?.type === 'idle' && !this.question) this.settle();
        break;
      }
      case 'session.idle': {
        if (!this.question) this.settle();
        break;
      }
      default:
        break;
    }
  }

  settle(): void {
    if (this.finished) return;
    this.finished = true;
    this.active = false;
    this.question = undefined;
    if (this.tool) {
      this.tool = undefined;
      this.callbacks.onStatus?.('');
    }
    this.callbacks.onSettled?.({
      text: this.text,
      error: this.error,
      aborted: this.aborted,
    });
  }
}
