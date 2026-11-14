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

export type AiErrorCode =
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_request'
  | 'model_not_found'
  | 'empty_response'
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
