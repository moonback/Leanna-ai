import type { FastifyBaseLogger } from 'fastify';

/**
 * Work that outlives a response (conversation summaries). Failures are logged, never
 * thrown; `settle()` waits for everything in flight (graceful shutdown, tests).
 */
export function createBackground(log: Pick<FastifyBaseLogger, 'error'>) {
  const tasks = new Set<Promise<void>>();
  return {
    run(name: string, fn: () => Promise<unknown>) {
      const task: Promise<void> = fn()
        .then(() => undefined)
        .catch((err: unknown) => log.error({ err }, `${name} failed`))
        .finally(() => tasks.delete(task));
      tasks.add(task);
    },
    async settle() {
      while (tasks.size) await Promise.allSettled([...tasks]);
    },
  };
}

export type Background = ReturnType<typeof createBackground>;
