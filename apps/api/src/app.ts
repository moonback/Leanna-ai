import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Env } from './env.js';
import { setupAuth } from './plugins/auth.js';
import { meRoutes } from './modules/me.js';

const startedAt = Date.now();

export async function buildApp(env: Env) {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  // Never leak internal error details (SQL, upstream messages) to clients.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    reply.status(status).send({
      error: status >= 500 ? 'Internal error' : err.message,
    });
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'LEANA AI API', version: '0.2.0' },
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
      version: '0.2.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  await app.register(meRoutes);

  return app;
}
