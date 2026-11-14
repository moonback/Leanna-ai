export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type StreamRequest = {
  model: string;
  system: string;
  history: ChatTurn[];
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type StreamEvent =
  { type: 'text'; text: string } | { type: 'usage'; inputTokens: number; outputTokens: number };

/** One adapter per vendor. Adapters throw AiError only. */
export interface AiProvider {
  readonly name: string;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}

export const PROVIDER_IDS = ['gemini', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type AiErrorCode =
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_request'
  | 'model_not_found'
  | 'empty_response'
  | 'payment_required'
  | 'auth';

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** HTTP status from any vendor → gateway error. Only 429/5xx are worth retrying. */
export function aiErrorFromStatus(status: number): AiError {
  if (status === 429) return new AiError('rate_limited', 'Provider rate limit', true);
  if (status === 401 || status === 403) return new AiError('auth', 'Provider rejected the API key');
  if (status === 402) return new AiError('payment_required', 'Provider account has no credits');
  if (status === 404) return new AiError('model_not_found', 'Model not available for this key');
  if (status === 408 || status >= 500) {
    return new AiError('unavailable', `Provider error ${status}`, true);
  }
  return new AiError('invalid_request', `Provider rejected the request (${status})`);
}
