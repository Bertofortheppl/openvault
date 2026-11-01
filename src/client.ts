import {
  createOpencodeClient,
  type OpencodeClient,
} from '@opencode-ai/sdk/v2/client';

export type { OpencodeClient };

export function createClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    throwOnError: false,
    responseStyle: 'fields',
  });
}

export function errorText(error: unknown, fallback = 'opencode request failed'): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return fallback;
  const value = error as {
    message?: string;
    data?: { message?: string };
    error?: { message?: string; data?: { message?: string } };
  };
  return (
    value.message ??
    value.data?.message ??
    value.error?.message ??
    value.error?.data?.message ??
    fallback
  );
}

export function statusOf(result: { response?: Response }): number | undefined {
  return result.response?.status;
}
