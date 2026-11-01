import type { OpencodeClient } from './client';
import { errorText, statusOf } from './client';
import type { AgentMode, ChatMessage } from './types';

function displayText(text: string): string {
  return text
    .replace(/^Use the "[^"]*" skill before answering\.\s*/, '')
    .replace(/^<context>[\s\S]*?<\/context>\s*/, '');
}

export class ChatSession {
  sessionId: string | null = null;

  constructor(
    private client: OpencodeClient | null,
    private readonly directory: string,
  ) {}

  setClient(client: OpencodeClient | null): void {
    this.client = client;
  }

  private get api(): OpencodeClient {
    if (!this.client) throw new Error('opencode client is not connected');
    return this.client;
  }

  async ensure(agent: AgentMode): Promise<string> {
    if (this.sessionId) {
      const existing = await this.api.v2.session.get({
        sessionID: this.sessionId,
      });
      if (!existing.error) return this.sessionId;
      if (statusOf(existing) !== 404) {
        throw new Error(errorText(existing.error, 'could not load the session'));
      }
      this.sessionId = null;
    }

    const created = await this.api.v2.session.create({
      location: { directory: this.directory },
      agent,
    });
    const id = created.data?.data.id;
    if (created.error || !id) {
      throw new Error(errorText(created.error, 'could not create a session'));
    }
    this.sessionId = id;
    return id;
  }

  reset(): void {
    this.sessionId = null;
  }

  async setAgent(agent: AgentMode): Promise<void> {
    if (!this.sessionId) return;
    await this.api.v2.session.switchAgent({
      sessionID: this.sessionId,
      agent,
    });
  }

  async prompt(
    text: string,
    agent: AgentMode,
    onSession?: (sessionId: string) => void,
  ): Promise<string> {
    let sessionId = await this.ensure(agent);
    let result = await this.api.v2.session.prompt({
      sessionID: sessionId,
      prompt: { text },
      delivery: 'queue',
    });

    if (statusOf(result) === 404) {
      this.sessionId = null;
      sessionId = await this.ensure(agent);
      onSession?.(sessionId);
      result = await this.api.v2.session.prompt({
        sessionID: sessionId,
        prompt: { text },
        delivery: 'queue',
      });
    }

    if (result.error) throw new Error(errorText(result.error, 'prompt failed'));
    return sessionId;
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId) return;
    await this.api.v2.session.interrupt({ sessionID: this.sessionId });
  }

  async history(): Promise<ChatMessage[]> {
    if (!this.sessionId) return [];
    const result = await this.api.v2.session.messages({
      sessionID: this.sessionId,
      limit: 200,
      order: 'asc',
    });
    if (result.error || !result.data) {
      if (statusOf(result) === 404) this.sessionId = null;
      return [];
    }

    const messages: ChatMessage[] = [];
    for (const message of result.data.data) {
      if (message.type === 'user') {
        messages.push({
          id: message.id,
          role: 'user',
          text: displayText(message.text),
          ts: message.time.created,
        });
        continue;
      }

      if (message.type !== 'assistant') continue;

      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n');
      const error = message.error
        ? errorText(message.error, 'assistant error')
        : undefined;

      if (text || error) {
        messages.push({
          id: message.id,
          role: 'assistant',
          text,
          ts: message.time.created,
          ...(error ? { error, partial: true } : {}),
        });
      }
    }

    return messages;
  }
}
