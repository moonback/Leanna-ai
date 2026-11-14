import { Worker } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import type { Embedder } from '../ai/embeddings.js';
import type { Gateway } from '../ai/gateway.js';
import type { Env } from '../env.js';
import { createMissionEngine } from './engine.js';
import { createMissionQueue, redisConnection, type MissionJob } from './queue.js';

export type MissionWorkerOptions = {
  env: Env;
  sql: Sql;
  gateway: Gateway | null;
  embedder?: Embedder | null;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /** Tests shorten BullMQ's stalled-job detection to exercise crash recovery quickly. */
  lockDurationMs?: number;
  stalledIntervalMs?: number;
};

/**
 * BullMQ worker + recovery sweep. A job whose worker died is detected as stalled and
 * re-run by another worker; the sweep re-enqueues missions whose job was lost entirely
 * (Redis flushed, enqueue failed after the database write).
 */
export function startMissionWorker(opts: MissionWorkerOptions) {
  const { env, log } = opts;
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required to run missions');
  const engine = createMissionEngine({
    sql: opts.sql,
    gateway: opts.gateway,
    log,
    leaseMs: env.MISSION_STEP_LEASE_MS,
    maxAttempts: env.MISSION_MAX_ATTEMPTS,
    dailyTokenLimit: env.AI_DAILY_TOKEN_LIMIT,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    embedder: opts.embedder ?? null,
    maxDistance: env.MEMORY_MAX_DISTANCE,
  });
  const queue = createMissionQueue(env.REDIS_URL, env.MISSIONS_QUEUE);
  const worker = new Worker<MissionJob>(
    env.MISSIONS_QUEUE,
    async (job) => engine.run(job.data.missionId),
    {
      connection: redisConnection(env.REDIS_URL),
      concurrency: env.WORKER_CONCURRENCY,
      lockDuration: opts.lockDurationMs ?? 60_000,
      stalledInterval: opts.stalledIntervalMs ?? 30_000,
      maxStalledCount: 3,
    },
  );
  worker.on('failed', (job, err) =>
    log.warn({ mission: job?.data.missionId, err: err.message }, 'mission job failed'),
  );

  const sweep = async () => {
    try {
      const ids = await engine.orphans(env.MISSION_SWEEP_MS);
      for (const id of ids) await queue.enqueue(id);
      if (ids.length) log.info({ count: ids.length }, 'recovery sweep re-enqueued missions');
      return ids;
    } catch (err) {
      log.error(err, 'recovery sweep failed');
      return [];
    }
  };
  void sweep(); // a restarted worker first picks up what was left behind
  const timer = setInterval(() => void sweep(), env.MISSION_SWEEP_MS);

  return {
    engine,
    worker,
    sweep,
    /** `force`: stop without waiting for running jobs (what a crash looks like to Redis). */
    async close(force = false) {
      clearInterval(timer);
      await worker.close(force);
      await queue.close();
    },
  };
}

export type MissionWorker = ReturnType<typeof startMissionWorker>;
