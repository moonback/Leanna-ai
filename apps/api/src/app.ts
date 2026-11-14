import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Env } from './env.js';
import { setupAuth } from './plugins/auth.js';
import { meRoutes } from './modules/me.js';
import { conversationRoutes } from './modules/conversations.js';
import { createGateway } from './ai/gateway.js';
import { geminiProvider } from './ai/gemini.js';
import type { AiProvider } from './ai/types.js';

const startedAt = Date.now();

/** `aiProvider` is injected by tests only; production uses Gemini when a key is set. */
export async function buildApp(env: Env, deps: { aiProvider?: AiProvider } = {}) {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  const provider =
    deps.aiProvider ?? (env.GEMINI_API_KEY ? geminiProvider(env.GEMINI_API_KEY) : null);
  const gateway = provider
    ? createGateway({
        provider,
        models: env.AI_MODELS,
        defaultModel: env.AI_DEFAULT_MODEL,
        timeoutMs: env.AI_TIMEOUT_MS,
        log: app.log,
      })
    : null;

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
      info: { title: 'LEANA AI API', version: '0.3.0' },
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
      version: '0.3.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  await app.register(meRoutes, { aiModels: env.AI_MODELS });
  await app.register(conversationRoutes, {
    gateway,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    dailyTokenLimit: env.AI_DAILY_TOKEN_LIMIT,
  });

  return app;
}
