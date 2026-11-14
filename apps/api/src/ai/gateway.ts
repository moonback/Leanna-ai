import type { FastifyBaseLogger } from 'fastify';
import { AiError, type AiProvider, type StreamEvent, type StreamRequest } from './types.js';

export type GatewayOptions = {
  provider: AiProvider;
  models: readonly string[];
  defaultModel: string;
  timeoutMs: number;
  maxRetries?: number;
  retryDelayMs?: number;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
};

export type GatewayRequest = Omit<StreamRequest, 'signal'> & { signal?: AbortSignal };

export type Gateway = ReturnType<typeof createGateway>;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

export function createGateway(opts: GatewayOptions) {
  const {
    provider,
    models,
    defaultModel,
    timeoutMs,
    maxRetries = 2,
    retryDelayMs = 500,
    log,
  } = opts;

  return {
    models,
    defaultModel,

    /** A user preference is honoured only if it is on the server allowlist. */
    resolveModel(preferred: unknown): string {
      return typeof preferred === 'string' && models.includes(preferred) ? preferred : defaultModel;
    },

    /**
     * Streams a reply with a hard timeout. Retries transient failures only before the first
     * text chunk, so a user never sees a duplicated partial answer.
     * Logs metadata only: prompts and replies are personal data and are never logged.
     */
    async *stream(req: GatewayRequest): AsyncGenerator<StreamEvent> {
      if (!models.includes(req.model)) throw new AiError('invalid_request', 'Model not allowed');

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      const started = Date.now();
      const meta = { provider: provider.name, model: req.model };
      let attempt = 0;
      let emitted = false;

      for (;;) {
        try {
          let usage: Extract<StreamEvent, { type: 'usage' }> | undefined;
          for await (const event of provider.stream({ ...req, signal })) {
            if (event.type === 'usage') usage = event;
            else emitted = true;
            yield event;
          }
          log.info(
            { ai: { ...meta, attempt, ms: Date.now() - started, outcome: 'ok', ...usage } },
            'ai stream completed',
          );
          return;
        } catch (raw) {
          let err =
            raw instanceof AiError ? raw : new AiError('unavailable', 'Unexpected provider error');
          if (timeout.aborted)
            err = new AiError('timeout', `No complete answer within ${timeoutMs} ms`);
          else if (signal.aborted) err = new AiError('aborted', 'Request aborted by the client');

          if (!emitted && err.retryable && attempt < maxRetries && !signal.aborted) {
            attempt += 1;
            await sleep(retryDelayMs * 2 ** (attempt - 1), signal);
            continue;
          }
          log.warn(
            { ai: { ...meta, attempt, ms: Date.now() - started, outcome: err.code } },
            'ai stream failed',
          );
          throw err;
        }
      }
    },
  };
}
