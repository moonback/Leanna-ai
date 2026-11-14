import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Env } from './env.js';
import { setupAuth } from './plugins/auth.js';
import { meRoutes } from './modules/me.js';
import { conversationRoutes } from './modules/conversations.js';
import { createGateway, type ProviderEntry } from './ai/gateway.js';
import { geminiProvider } from './ai/gemini.js';
import { openRouterProvider } from './ai/openrouter.js';
import type { AiCatalog } from './ai/catalog.js';
import type { AiProvider, ProviderId } from './ai/types.js';
import { geminiEmbedder, openRouterEmbedder, type Embedder } from './ai/embeddings.js';
import { createBackground } from './background.js';
import { createMemoryService } from './memory/service.js';
import { memoryRoutes } from './modules/memories.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Work that outlives a response; `app.close()` waits for it. */
    background: ReturnType<typeof createBackground>;
  }
}

/** Embeddings vendor: explicit choice, or the first one with a key ('auto'). */
function embedderFor(env: Env): Embedder | null {
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

const startedAt = Date.now();

/**
 * `aiProviders` and `embedder` are injected by tests only (they replace key-based vendors
 * entirely); in production each vendor is enabled by its API key.
 */
export async function buildApp(
  env: Env,
  deps: {
    aiProviders?: Partial<Record<ProviderId, AiProvider>>;
    embedder?: Embedder | null;
  } = {},
) {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  const catalog: AiCatalog = {
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
  const live = deps.aiProviders ?? {
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
        log: app.log,
      })
    : null;

  const background = createBackground(app.log);
  app.decorate('background', background);
  app.addHook('onClose', () => background.settle());
  const memory = createMemoryService({
    gateway,
    embedder: deps.embedder !== undefined ? deps.embedder : embedderFor(env),
    maxDistance: env.MEMORY_MAX_DISTANCE,
    recallCount: env.MEMORY_RECALL_COUNT,
    log: app.log,
  });

  // Never leak internal error details (SQL, upstream messages) to clients.
  app.setErrorHandler((err: Error & { statusCode?: number; expose?: boolean }, req, reply) => {
    const status = err.statusCode ?? 500;
    const hide = status >= 500 && !err.expose;
    if (hide) req.log.error(err);
    reply.status(hide ? 500 : status).send({ error: hide ? 'Internal error' : err.message });
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'LEANA AI API', version: '0.4.0' },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  setupAuth(app, env);

  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness check',
        response: {
          200: {
            type: 'object',
            required: ['status', 'version', 'uptimeSeconds'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              version: { type: 'string' },
              uptimeSeconds: { type: 'number' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      version: '0.4.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  await app.register(meRoutes, { gateway });
  await app.register(memoryRoutes, { memory });
  await app.register(conversationRoutes, {
    gateway,
    catalog,
    memory,
    background,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    dailyTokenLimit: env.AI_DAILY_TOKEN_LIMIT,
  });

  return app;
}
