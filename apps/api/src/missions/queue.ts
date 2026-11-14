import { Queue } from 'bullmq';

export type MissionJob = { missionId: string };

export const redisConnection = (url: string) => ({ url, maxRetriesPerRequest: null });

/**
 * The queue only wakes the worker up: the database is the source of truth, a duplicate
 * job is harmless (one processor per mission, see engine.ts) and a lost one is picked up
 * by the worker's recovery sweep.
 */
export function createMissionQueue(url: string, name: string) {
  const queue = new Queue<MissionJob>(name, { connection: redisConnection(url) });
  return {
    queue,
    async enqueue(missionId: string) {
      await queue.add(
        'run',
        { missionId },
        {
          // Transient failures (provider 429/5xx) are retried with backoff; the engine
          // counts attempts per step in the database, which is what ends a mission.
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    },
    close: () => queue.close(),
  };
}

export type MissionQueue = ReturnType<typeof createMissionQueue>;
