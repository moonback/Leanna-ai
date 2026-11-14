import type { FastifyBaseLogger } from 'fastify';
import {
  AiError,
  type AiProvider,
  type ProviderId,
  type StreamEvent,
  type StreamRequest,
} from './types.js';

/** A configured vendor and the models users may pick from it (server-side allowlist). */
export type ProviderEntry = {
  provider: AiProvider;
  models: readonly string[];
  defaultModel: string;
};

export type GatewayOptions = {
  providers: Partial<Record<ProviderId, ProviderEntry>>;
  defaultProvider: ProviderId;
  timeoutMs: number;
  maxRetries?: number;
  retryDelayMs?: number;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
};

export type GatewayRequest = Omit<StreamRequest, 'signal'> & {
  provider: ProviderId;
  signal?: AbortSignal;
};

export type Gateway = ReturnType<typeof createGateway>;
export type AiChoice = { provider: ProviderId; model: string };

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

export function createGateway(opts: GatewayOptions) {
  const { providers, timeoutMs, maxRetries = 2, retryDelayMs = 500, log } = opts;
  const configured = Object.keys(providers) as ProviderId[];
  if (!configured.length) throw new Error('createGateway needs at least one provider');
  // The configured default wins; otherwise the first provider that has a key.
  const defaultProvider = providers[opts.defaultProvider] ? opts.defaultProvider : configured[0]!;

  const isAllowed = (choice: Partial<AiChoice>): choice is AiChoice =>
    !!choice.provider &&
    !!choice.model &&
    !!providers[choice.provider]?.models.includes(choice.model);

  return {
    providers,
    defaultProvider,

    /** Default choice: the default provider with its default model. */
    get defaultChoice(): AiChoice {
      return { provider: defaultProvider, model: providers[defaultProvider]!.defaultModel };
    },

    isAllowed,

    /**
     * Applies a user preference only if it is still allowed by the server: an unconfigured
     * provider or a model removed from the allowlist falls back to defaults.
     */
    resolve(pref: { ai_provider?: unknown; ai_model?: unknown } | null | undefined): AiChoice {
      const provider = pref?.ai_provider as ProviderId | undefined;
      const entry = provider ? providers[provider] : undefined;
      if (!provider || !entry) return this.defaultChoice;
      const model = pref?.ai_model;
      return {
        provider,
        model:
          typeof model === 'string' && entry.models.includes(model) ? model : entry.defaultModel,
      };
    },

    /**
     * Streams a reply with a hard timeout. Retries transient failures only before the first
     * text chunk, so a user never sees a duplicated partial answer.
     * Logs metadata only: prompts and replies are personal data and are never logged.
     */
    async *stream(req: GatewayRequest): AsyncGenerator<StreamEvent> {
      if (!isAllowed(req)) throw new AiError('invalid_request', 'Model not allowed');
      const { provider } = providers[req.provider]!;

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

    /** Non-streamed call for background work (memory extraction, summaries). */
    async complete(req: GatewayRequest) {
      let text = '';
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      for await (const event of this.stream(req)) {
        if (event.type === 'text') text += event.text;
        else usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      }
      return { text, usage };
    },
  };
}
