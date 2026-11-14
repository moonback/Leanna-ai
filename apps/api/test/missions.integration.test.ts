// Requires the local Supabase stack and Redis (REDIS_URL, DATABASE_URL in .env).
// Real API, real BullMQ queue, real worker (in-process, as `leana_worker`), real database;
// only the AI model is a test double. Proves the full mission cycle and crash recovery.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { createAiGateway } from '../src/ai/setup.js';
import { AiError, type AiProvider, type StreamEvent, type StreamRequest } from '../src/ai/types.js';
import { PLAN_SYSTEM, STEP_SYSTEM } from '../src/missions/plan.js';
import { startMissionWorker, type MissionWorker } from '../src/missions/worker.js';
import { signUp } from './helpers.js';

const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  GEMINI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  MISSIONS_QUEUE: `test-missions-${randomUUID()}`,
  MISSION_STEP_LEASE_MS: '2000',
  MISSION_SWEEP_MS: '1000',
  MISSION_MAX_ATTEMPTS: '3',
});
const silent = { info() {}, warn() {}, error() {} };

type Plan = { title: string; instruction: string; requires_approval?: boolean }[];
type StepBehaviour = (title: string, call: number) => Promise<string> | string;

/** The model: plans what the test says, answers steps with "Fait : <title>". */
function scriptedModel() {
  let plan: Plan | string = [];
  let behaviour: StepBehaviour = (title) => `Fait : ${title}`;
  const stepCalls: string[] = [];
  const provider: AiProvider = {
    name: 'test-double',
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
      const input = req.history[0]!.content;
      if (req.system === PLAN_SYSTEM) {
        yield {
          type: 'text',
          text: typeof plan === 'string' ? plan : JSON.stringify({ steps: plan }),
        };
        yield { type: 'usage', inputTokens: 40, outputTokens: 30 };
        return;
      }
      if (req.system === STEP_SYSTEM) {
        const title = /Étape à réaliser maintenant \(\d+\/\d+\) : (.*)/.exec(input)![1]!;
        stepCalls.push(title);
        const call = stepCalls.filter((t) => t === title).length;
        yield { type: 'text', text: await behaviour(title, call) };
        yield { type: 'usage', inputTokens: 20, outputTokens: 10 };
        return;
      }
      throw new Error(`unexpected system prompt: ${req.system.slice(0, 40)}`);
    },
  };
  return {
    provider,
    stepCalls,
    plan: (p: Plan | string) => (plan = p),
    steps: (b: StepBehaviour) => (behaviour = b),
    reset() {
      plan = [];
      behaviour = (title) => `Fait : ${title}`;
      stepCalls.length = 0;
    },
  };
}

type Mission = {
  id: string;
  title: string;
  status: string;
  result: string | null;
  error_code: string | null;
  steps: { position: number; status: string; attempt: number; output: string | null }[];
  approvals: { id: string; kind: string; status: string; step_id: string | null }[];
};

describe('missions (integration)', () => {
  const model = scriptedModel();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;
  const pools: postgres.Sql[] = [];
  let worker: MissionWorker | null = null;

  const workerSql = () => {
    const sql = postgres(env.DATABASE_URL!, {
      max: 6,
      connection: { role: 'leana_worker' },
      onnotice: () => {},
    });
    pools.push(sql);
    return sql;
  };
  const startWorker = (sql = workerSql()) =>
    startMissionWorker({
      env,
      sql,
      gateway: createAiGateway(env, silent, { gemini: model.provider }).gateway,
      log: silent,
      lockDurationMs: 1000,
      stalledIntervalMs: 500,
    });

  beforeAll(async () => {
    if (!env.REDIS_URL || !env.DATABASE_URL) throw new Error('REDIS_URL and DATABASE_URL needed');
    app = await buildApp(env, { aiProviders: { gemini: model.provider } });
    [alice, bob] = await Promise.all([signUp(env, 'Alice'), signUp(env, 'Bob')]);
    worker = startWorker();
  });
  afterAll(async () => {
    await worker?.close(true);
    await app.close();
    await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  });
  beforeEach(() => model.reset());

  const call = (method: 'GET' | 'POST', url: string, payload?: object, who = alice) =>
    app.inject({ method, url, headers: who.auth, ...(payload && { payload }) });
  const create = async (goal: string, who = alice) => {
    const res = await call('POST', '/missions', { goal }, who);
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const get = async (id: string, who = alice) =>
    (await call('GET', `/missions/${id}`, undefined, who)).json<Mission>();
  const until = async (id: string, ok: (m: Mission) => boolean, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const m = await get(id);
      if (ok(m)) return m;
      if (Date.now() > end) throw new Error(`timeout; last state ${JSON.stringify(m)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const pendingApproval = (m: Mission) => m.approvals.find((a) => a.status === 'pending');
  const decide = (approvalId: string, decision: 'approved' | 'rejected', who = alice) =>
    call('POST', `/approvals/${approvalId}/decide`, { decision }, who);

  it('runs the full cycle: plan, approve, step approval, execute, result, trail', async () => {
    model.plan([
      { title: 'Lister les options', instruction: 'Trois destinations' },
      { title: 'Rédiger l’e-mail', instruction: 'E-mail aux amis', requires_approval: true },
      { title: 'Synthèse', instruction: 'Récapitulatif final' },
    ]);
    const id = await create('Organiser un week-end entre amis');

    // 1. The worker plans, then waits for the plan to be approved: nothing runs before.
    let m = await until(id, (x) => x.status === 'awaiting_approval');
    expect(m.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(m.approvals).toEqual([expect.objectContaining({ kind: 'plan', status: 'pending' })]);
    expect(model.stepCalls).toEqual([]);
    const pending = await call('GET', '/approvals');
    expect(pending.json()).toEqual([
      expect.objectContaining({ mission_id: id, kind: 'plan', mission: { title: m.title } }),
    ]);

    // 2. Approved: step 1 runs, step 2 needs its own decision.
    expect((await decide(pendingApproval(m)!.id, 'approved')).statusCode).toBe(200);
    m = await until(id, (x) => x.approvals.length === 2 && x.status === 'awaiting_approval');
    expect(m.steps.map((s) => s.status)).toEqual(['done', 'pending', 'pending']);
    expect(pendingApproval(m)).toMatchObject({ kind: 'step', step_id: expect.any(String) });
    expect(model.stepCalls).toEqual(['Lister les options']);

    // A decision is final.
    const first = m.approvals.find((a) => a.kind === 'plan')!;
    expect((await decide(first.id, 'rejected')).statusCode).toBe(409);

    // 3. Approved again: the mission completes with the last step's output.
    await decide(pendingApproval(m)!.id, 'approved');
    m = await until(id, (x) => x.status === 'completed');
    expect(m.steps.map((s) => [s.status, s.attempt])).toEqual([
      ['done', 1],
      ['done', 1],
      ['done', 1],
    ]);
    expect(m.result).toBe('Fait : Synthèse');
    expect(model.stepCalls).toEqual(['Lister les options', 'Rédiger l’e-mail', 'Synthèse']);
    // A finished mission cannot be cancelled any more.
    expect((await call('POST', `/missions/${id}/cancel`)).statusCode).toBe(409);

    // 4. The trail: activity, notifications, usage charged to the mission.
    const activity = (await call('GET', '/activity?limit=50')).json<
      { mission_id: string; kind: string }[]
    >();
    expect(
      activity
        .filter((a) => a.mission_id === id)
        .map((a) => a.kind)
        .reverse(),
    ).toEqual([
      'mission.created',
      'approval.requested',
      'approval.approved',
      'step.done',
      'approval.requested',
      'approval.approved',
      'step.done',
      'step.done',
      'mission.completed',
    ]);
    const notes = (await call('GET', '/notifications')).json<{
      items: { title: string; link: string }[];
      unread: number;
    }>();
    expect(notes.items.map((n) => n.title)).toContain(
      'Mission terminée : Organiser un week-end entre amis',
    );
    expect(notes.items[0]!.link).toBe(`/missions/${id}`);
    expect(notes.unread).toBeGreaterThanOrEqual(3);
    const marked = (await call('POST', '/notifications/read', { all: true })).json<{
      marked: number;
    }>();
    expect(marked.marked).toBe(notes.unread);
    expect((await call('GET', '/notifications')).json<{ unread: number }>().unread).toBe(0);

    const sql = pools[0]!;
    const usage = await sql<{ n: number }[]>`
      select count(*)::int as n from public.ai_usage where mission_id = ${id} and kind = 'mission'`;
    expect(usage[0]!.n).toBe(4); // 1 plan + 3 steps
  });

  it('keeps missions private', async () => {
    model.plan([{ title: 'Unique', instruction: 'x' }]);
    const id = await create('Projet secret');
    const m = await until(id, (x) => x.status === 'awaiting_approval');
    expect((await call('GET', `/missions/${id}`, undefined, bob)).statusCode).toBe(404);
    expect((await call('POST', `/missions/${id}/cancel`, undefined, bob)).statusCode).toBe(404);
    expect((await decide(pendingApproval(m)!.id, 'approved', bob)).statusCode).toBe(404);
    expect((await call('GET', '/missions', undefined, bob)).json()).toEqual([]);
    expect((await call('GET', '/approvals', undefined, bob)).json()).toEqual([]);
    await call('POST', `/missions/${id}/cancel`);
  });

  it('stops when the plan is rejected', async () => {
    model.plan([{ title: 'Étape', instruction: 'x' }]);
    const id = await create('Plan à refuser');
    const m = await until(id, (x) => x.status === 'awaiting_approval');
    await decide(pendingApproval(m)!.id, 'rejected');
    const done = await until(id, (x) => x.status === 'cancelled');
    expect(done.steps.map((s) => s.status)).toEqual(['pending']);
    expect(model.stepCalls).toEqual([]);
  });

  it('cancels a running mission: the current step is discarded, nothing runs after', async () => {
    model.plan([
      { title: 'Longue étape', instruction: 'x' },
      { title: 'Suite', instruction: 'x' },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    model.steps(async (title) => {
      await gate;
      return `Fait : ${title}`;
    });
    const id = await create('Mission à annuler');
    const m = await until(id, (x) => x.status === 'awaiting_approval');
    await decide(pendingApproval(m)!.id, 'approved');
    await until(id, (x) => x.steps[0]!.status === 'running');

    const cancelled = await call('POST', `/missions/${id}/cancel`);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    release();
    const final = await until(id, (x) => x.steps[0]!.status === 'skipped');
    expect(final.status).toBe('cancelled');
    expect(final.steps[0]!.output).toBeNull();
    expect(model.stepCalls).toEqual(['Longue étape']);
    // Cancelling again is a no-op.
    expect((await call('POST', `/missions/${id}/cancel`)).json()).toMatchObject({
      status: 'cancelled',
    });
  });

  it('retries an outage that outlasts the gateway retries as a new step attempt', async () => {
    model.plan([{ title: 'Fragile', instruction: 'x' }]);
    // The gateway retries twice by itself (3 calls); only then does the job fail and the
    // queue run it again, which claims the step as attempt 2.
    model.steps((title, call) => {
      if (call <= 3) throw new AiError('unavailable', 'Provider error 503', true);
      return `Fait : ${title}`;
    });
    const id = await create('Mission fragile');
    const m = await until(id, (x) => x.status === 'awaiting_approval');
    await decide(pendingApproval(m)!.id, 'approved');
    const done = await until(id, (x) => x.status === 'completed', 20_000);
    expect(done.steps[0]).toMatchObject({ status: 'done', attempt: 2 });
  });

  it('fails at once on a fatal provider error, and on an unusable plan', async () => {
    model.plan([{ title: 'Payante', instruction: 'x' }]);
    model.steps(() => {
      throw new AiError('payment_required', 'No credits');
    });
    const id = await create('Mission sans crédits');
    const m = await until(id, (x) => x.status === 'awaiting_approval');
    await decide(pendingApproval(m)!.id, 'approved');
    const failed = await until(id, (x) => x.status === 'failed');
    expect(failed).toMatchObject({ error_code: 'payment_required' });
    expect(failed.steps[0]).toMatchObject({ status: 'failed', attempt: 1 });

    model.plan('Je ne sais pas faire de plan.');
    const bad = await create('Mission impossible');
    expect(await until(bad, (x) => x.status === 'failed')).toMatchObject({
      error_code: 'invalid_plan',
    });
  });

  it('recovers from a worker crash mid-step, and the dead worker cannot write', async () => {
    // Worker A will hang forever inside step 1, like a process that froze or died.
    await worker!.close(true);
    worker = null;
    model.plan([
      { title: 'Étape A', instruction: 'x' },
      { title: 'Étape B', instruction: 'x' },
    ]);
    let releaseZombie!: () => void;
    const zombie = new Promise<void>((r) => (releaseZombie = r));
    model.steps(async (title, call) => {
      if (title === 'Étape A' && call === 1) {
        await zombie;
        return 'ZOMBIE';
      }
      return `Fait : ${title}`;
    });

    const sqlA = workerSql();
    const workerA = startWorker(sqlA);
    const id = await create('Mission résiliente');
    const m = await until(id, (x) => x.status === 'awaiting_approval');
    await decide(pendingApproval(m)!.id, 'approved');
    await until(id, (x) => x.steps[0]!.status === 'running' && x.steps[0]!.attempt === 1);

    // Crash: the job is abandoned without completion, its database sessions die.
    await workerA.close(true);
    await sqlA.end({ timeout: 0 });

    // Worker B: BullMQ sees the stalled job, B takes the mission over as attempt 2.
    worker = startWorker();
    const done = await until(id, (x) => x.status === 'completed', 20_000);
    expect(done.steps.map((s) => [s.status, s.attempt, s.output])).toEqual([
      ['done', 2, 'Fait : Étape A'],
      ['done', 1, 'Fait : Étape B'],
    ]);
    expect(done.result).toBe('Fait : Étape B');

    // The frozen worker wakes up: its result is never written.
    releaseZombie();
    await new Promise((r) => setTimeout(r, 300));
    expect((await get(id)).steps[0]!.output).toBe('Fait : Étape A');

    const activity = (await call('GET', '/activity?limit=50')).json<
      { mission_id: string; kind: string; summary: string }[]
    >();
    expect(activity.find((a) => a.mission_id === id && a.kind === 'step.retried')?.summary).toBe(
      'Étape 1 reprise après incident (1) : Étape A',
    );
  });

  it('picks up a mission whose wake-up job was lost (recovery sweep)', async () => {
    // An API on another queue name: its job never reaches our worker, like a lost job.
    const lostApp = await buildApp(
      { ...env, MISSIONS_QUEUE: `lost-${randomUUID()}` },
      { aiProviders: { gemini: model.provider } },
    );
    try {
      model.plan([{ title: 'Récupérée', instruction: 'x' }]);
      const res = await lostApp.inject({
        method: 'POST',
        url: '/missions',
        headers: alice.auth,
        payload: { goal: 'Mission orpheline' },
      });
      const id = res.json<{ id: string }>().id;
      // Within MISSION_SWEEP_MS (+ one sweep period), the worker finds it anyway.
      expect((await until(id, (x) => x.status === 'awaiting_approval', 10_000)).steps).toHaveLength(
        1,
      );
      await call('POST', `/missions/${id}/cancel`);
    } finally {
      await lostApp.close();
    }
  });

  it('validates input and reports when missions are not configured', async () => {
    expect((await call('POST', '/missions', { goal: '' })).statusCode).toBe(400);
    expect((await call('POST', '/missions', { goal: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await call('GET', '/missions/not-a-uuid')).statusCode).toBe(400);
    expect((await call('POST', '/notifications/read', {})).statusCode).toBe(400);

    const off = await buildApp(
      { ...env, REDIS_URL: undefined },
      { aiProviders: { gemini: model.provider } },
    );
    try {
      const res = await off.inject({
        method: 'POST',
        url: '/missions',
        headers: alice.auth,
        payload: { goal: 'x' },
      });
      expect(res.statusCode).toBe(503);
      const cfg = await off.inject({ method: 'GET', url: '/missions/config', headers: alice.auth });
      expect(cfg.json()).toEqual({ configured: false });
    } finally {
      await off.close();
    }
  });
});
