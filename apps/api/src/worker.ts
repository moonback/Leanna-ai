// Mission worker process: `pnpm --filter @leana/api worker` (dev: `dev:worker`).
import pino from 'pino';
import postgres from 'postgres';
import { loadEnv } from './env.js';
import { createAiGateway, embedderFor } from './ai/setup.js';
import { startMissionWorker } from './missions/worker.js';

const env = loadEnv();
const log = pino({ name: 'leana-worker' });
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required by the worker');

// Every connection runs as `leana_worker`: the login only needs to be a member of it.
const sql = postgres(env.DATABASE_URL, {
  max: env.WORKER_CONCURRENCY * 2 + 2,
  connection: { role: 'leana_worker', application_name: 'leana-worker' },
});
const { gateway } = createAiGateway(env, log);
if (!gateway) log.warn('no AI provider configured: missions will fail with ai_not_configured');

const worker = startMissionWorker({ env, sql, gateway, embedder: embedderFor(env), log });
log.info({ queue: env.MISSIONS_QUEUE, concurrency: env.WORKER_CONCURRENCY }, 'worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'worker stopping');
    await worker.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
