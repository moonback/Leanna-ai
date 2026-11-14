import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Env } from './env.js';
import { setupAuth } from './plugins/auth.js';
import { meRoutes } from './modules/me.js';
import { conversationRoutes } from './modules/conversations.js';
import type { AiProvider, ProviderId } from './ai/types.js';
import type { Embedder } from './ai/embeddings.js';
import { createAiGateway, embedderFor } from './ai/setup.js';
import { createBackground } from './background.js';
import { createMemoryService } from './memory/service.js';
import { memoryRoutes } from './modules/memories.js';
import { missionRoutes } from './modules/missions.js';
import { agentRoutes } from './modules/agents.js';
import { createMissionQueue } from './missions/queue.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Work that outlives a response; `app.close()` waits for it. */
    background: ReturnType<typeof createBackground>;
  }
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

  const { catalog, gateway } = createAiGateway(env, app.log, deps.aiProviders);

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
      info: { title: 'LEANA AI API', version: '0.6.0' },
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
      version: '0.6.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  await app.register(meRoutes, { gateway });
  // Missions run in the worker process; the API only creates them and wakes the worker.
  const queue = env.REDIS_URL ? createMissionQueue(env.REDIS_URL, env.MISSIONS_QUEUE) : null;
  if (queue) app.addHook('onClose', () => queue.close());

  await app.register(memoryRoutes, { memory });
  await app.register(agentRoutes, { gateway });
  await app.register(missionRoutes, {
    gateway,
    queue,
    dailyTokenLimit: env.AI_DAILY_TOKEN_LIMIT,
  });
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
