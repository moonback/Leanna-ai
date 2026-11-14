import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env.js';
import type { AiCatalog } from './catalog.js';
import { geminiEmbedder, openRouterEmbedder, type Embedder } from './embeddings.js';
import { createGateway, type ProviderEntry } from './gateway.js';
import { geminiProvider } from './gemini.js';
import { openRouterProvider } from './openrouter.js';
import type { AiProvider, ProviderId } from './types.js';

export function aiCatalog(env: Env): AiCatalog {
  return {
    gemini: {
      label: 'Google Gemini',
      models: env.GEMINI_MODELS,
      defaultModel: env.GEMINI_DEFAULT_MODEL,
    },
    openrouter: {
      label: 'OpenRouter',
      models: env.OPENROUTER_MODELS,
      defaultModel: env.OPENROUTER_DEFAULT_MODEL,
    },
  };
}

/**
 * The gateway shared by the API and the mission worker, or null without any key.
 * `injected` (tests only) replaces key-based providers entirely.
 */
export function createAiGateway(
  env: Env,
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  injected?: Partial<Record<ProviderId, AiProvider>>,
) {
  const catalog = aiCatalog(env);
  const live = injected ?? {
    ...(env.GEMINI_API_KEY && { gemini: geminiProvider(env.GEMINI_API_KEY) }),
    ...(env.OPENROUTER_API_KEY && { openrouter: openRouterProvider(env.OPENROUTER_API_KEY) }),
  };
  const providers: Partial<Record<ProviderId, ProviderEntry>> = {};
  for (const [id, provider] of Object.entries(live) as [ProviderId, AiProvider][]) {
    providers[id] = {
      provider,
      models: catalog[id].models,
      defaultModel: catalog[id].defaultModel,
    };
  }
  const gateway = Object.keys(providers).length
    ? createGateway({
        providers,
        defaultProvider: env.AI_DEFAULT_PROVIDER,
        timeoutMs: env.AI_TIMEOUT_MS,
        log,
      })
    : null;
  return { catalog, gateway };
}

/** Embeddings vendor: explicit choice, or the first one with a key ('auto'). */
export function embedderFor(env: Env): Embedder | null {
  const choice =
    env.EMBEDDINGS_PROVIDER !== 'auto'
      ? env.EMBEDDINGS_PROVIDER
      : env.GEMINI_API_KEY
        ? 'gemini'
        : env.OPENROUTER_API_KEY
          ? 'openrouter'
          : 'none';
  if (choice === 'gemini' && env.GEMINI_API_KEY) {
    return geminiEmbedder(env.GEMINI_API_KEY, env.GEMINI_EMBEDDING_MODEL);
  }
  if (choice === 'openrouter' && env.OPENROUTER_API_KEY) {
    return openRouterEmbedder(env.OPENROUTER_API_KEY, env.OPENROUTER_EMBEDDING_MODEL);
  }
  return null;
}
