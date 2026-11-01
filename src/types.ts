export type AgentMode = 'build' | 'plan';

export interface OpenVaultSettings {
  opencodePath: string;
  autoStart: boolean;
  injectContext: boolean;
}

export const DEFAULT_SETTINGS: OpenVaultSettings = {
  opencodePath: '',
  autoStart: true,
  injectContext: true,
};

export interface PersistedData {
  settings?: Partial<OpenVaultSettings>;
  state?: {
    sessionId?: string | null;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  error?: string;
  partial?: boolean;
}

export interface PermissionRequest {
  id: string;
  action: string;
  resources: string[];
}

export type ServerState = 'stopped' | 'starting' | 'ready' | 'error';

export interface ServerStatus {
  state: ServerState;
  version?: string;
  message?: string;
}

export const uid = (): string =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
