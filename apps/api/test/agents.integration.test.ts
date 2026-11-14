// Requires the local Supabase stack and Redis. Real API, queue, worker (as leana_worker)
// and database; the model is scripted. Proves that agents only use the tools they are
// given, that writes wait for the user's decision, and that tools touch only the owner's data.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { createAiGateway } from '../src/ai/setup.js';
import type { AiProvider, StreamEvent, StreamRequest } from '../src/ai/types.js';
import { PLAN_SYSTEM } from '../src/missions/plan.js';
import { startMissionWorker, type MissionWorker } from '../src/missions/worker.js';
import { TOOLS } from '../src/tools/registry.js';
import { signUp } from './helpers.js';

const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  GEMINI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  MISSIONS_QUEUE: `test-agents-${randomUUID()}`,
  MISSION_SWEEP_MS: '1000',
});
const silent = { info() {}, warn() {}, error() {} };

/**
 * Scripted model. Plans one step; in an agent step, `script` receives the turns so far
 * and returns the next reply (a tool call or a final answer).
 */
function scriptedModel() {
  const agentCalls: StreamRequest[] = [];
  let script: (history: StreamRequest['history']) => object = () => ({ final: 'Fini' });
  const provider: AiProvider = {
    name: 'test-double',
    async *stream(req): AsyncGenerator<StreamEvent> {
      if (req.system.startsWith(PLAN_SYSTEM)) {
        yield {
          type: 'text',
          text: JSON.stringify({
            steps: [{ title: 'Travailler', instruction: 'Avec les outils' }],
          }),
        };
        return;
      }
      agentCalls.push(req);
      yield { type: 'text', text: JSON.stringify(script(req.history)) };
    },
  };
  return {
    provider,
    agentCalls,
    play: (fn: typeof script) => (script = fn),
    reset() {
      agentCalls.length = 0;
      script = () => ({ final: 'Fini' });
    },
  };
}

/** Reply n (0-based) of a step is the n-th entry; the tool results come back in between. */
const sequence =
  (...replies: object[]) =>
  (history: StreamRequest['history']) =>
    replies[Math.min((history.length - 1) / 2, replies.length - 1)]!;

type ToolCall = { tool: string; status: string; output: unknown; error: string | null };
type Mission = {
  id: string;
  status: string;
  result: string | null;
  agent: { id: string; name: string } | null;
  approvals: { id: string; kind: string; status: string; summary: string }[];
  tool_calls: ToolCall[];
};

describe('agents and tools (integration)', () => {
  const model = scriptedModel();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;
  let sql: postgres.Sql;
  let worker: MissionWorker;

  beforeAll(async () => {
    app = await buildApp(env, { aiProviders: { gemini: model.provider }, embedder: null });
    [alice, bob] = await Promise.all([signUp(env, 'Alice'), signUp(env, 'Bob')]);
    sql = postgres(env.DATABASE_URL!, {
      max: 6,
      connection: { role: 'leana_worker' },
      onnotice: () => {},
    });
    worker = startMissionWorker({
      env,
      sql,
      gateway: createAiGateway(env, silent, { gemini: model.provider }).gateway,
      embedder: null,
      log: silent,
      lockDurationMs: 1000,
      stalledIntervalMs: 500,
    });
    await call('POST', '/memories', { content: 'Adore les pizzas napolitaines' });
    await call('POST', '/memories', { content: 'Bob adore les pizzas aussi' }, bob);
  });
  afterAll(async () => {
    await worker.close(true);
    await app.close();
    await sql.end({ timeout: 1 });
  });
  beforeEach(() => model.reset());

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    who = alice,
  ) => app.inject({ method, url, headers: who.auth, ...(payload && { payload }) });
  const agent = async (body: object, who = alice) => {
    const res = await call('POST', '/agents', body, who);
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; tools: string[] }>();
  };
  const get = async (id: string) => (await call('GET', `/missions/${id}`)).json<Mission>();
  const until = async (id: string, ok: (m: Mission) => boolean) => {
    const end = Date.now() + 15_000;
    for (;;) {
      const m = await get(id);
      if (ok(m)) return m;
      if (Date.now() > end) throw new Error(`timeout; last state ${JSON.stringify(m)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const pending = (m: Mission) => m.approvals.find((a) => a.status === 'pending');
  /** Creates a mission with an agent and approves its plan. */
  const launch = async (agentId: string) => {
    const res = await call('POST', '/missions', {
      goal: 'Une mission outillée',
      agent_id: agentId,
    });
    const id = res.json<{ id: string }>().id;
    const m = await until(id, (x) => x.status === 'awaiting_approval');
    await call('POST', `/approvals/${pending(m)!.id}/decide`, { decision: 'approved' });
    return id;
  };

  it('keeps the code registry and the database catalog identical', async () => {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false },
      global: { headers: alice.auth },
    });
    const { data } = await sb.from('tools').select('name, risk').order('name');
    expect(data).toEqual(
      TOOLS.map((t) => ({ name: t.name, risk: t.risk })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    const listed = (await call('GET', '/tools')).json<{ name: string; input: object }[]>();
    expect(listed.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(listed[0]!.input).toMatchObject({ type: 'object' });
  });

  it('manages agents: validation, private to their owner', async () => {
    expect((await call('POST', '/agents', { name: 'X', tools: ['shell.exec'] })).statusCode).toBe(
      400,
    );
    expect((await call('POST', '/agents', { name: '' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/agents', { name: 'X', provider: 'gemini', model: 'gpt-x' })).statusCode,
    ).toBe(400);
    const a = await agent({ name: 'Privé', tools: ['clock.now', 'clock.now'] });
    expect(a.tools).toEqual(['clock.now']);
    expect((await call('GET', `/agents/${a.id}`, undefined, bob)).statusCode).toBe(404);
    expect((await call('PATCH', `/agents/${a.id}`, { tools: [] }, bob)).statusCode).toBe(404);
    expect((await call('DELETE', `/agents/${a.id}`, undefined, bob)).statusCode).toBe(404);
    const theft = await call('POST', '/missions', { goal: 'x', agent_id: a.id }, bob);
    expect(theft.statusCode).toBe(400);
    const edited = await call('PATCH', `/agents/${a.id}`, { instructions: 'Sois brève' });
    expect(edited.json()).toMatchObject({ instructions: 'Sois brève', tools: ['clock.now'] });
  });

  it('uses read tools on the owner’s data only, then answers with their results', async () => {
    const a = await agent({
      name: 'Chercheur',
      instructions: 'Vérifie toujours la mémoire.',
      tools: ['memory.search', 'math.calculate'],
    });
    model.play(
      sequence(
        { tool: 'memory.search', input: { query: 'pizza' } },
        { tool: 'math.calculate', input: { expression: '2*21' } },
        { final: 'Pizza napolitaine pour 42 personnes' },
      ),
    );
    const id = await launch(a.id);
    const m = await until(id, (x) => x.status === 'completed');
    expect(m.result).toBe('Pizza napolitaine pour 42 personnes');
    expect(m.agent).toEqual({ id: a.id, name: 'Chercheur' });
    expect(m.tool_calls.map((c) => [c.tool, c.status])).toEqual([
      ['memory.search', 'succeeded'],
      ['math.calculate', 'succeeded'],
    ]);
    // Bob's matching memory is invisible to Alice's agent.
    const found = (m.tool_calls[0]!.output as { memories: { content: string }[] }).memories;
    expect(found.map((x) => x.content)).toEqual(['Adore les pizzas napolitaines']);
    expect(m.tool_calls[1]!.output).toEqual({ expression: '2*21', result: 42 });

    // The model saw its role, its tools only, and each result as data.
    const last = model.agentCalls.at(-1)!;
    expect(last.system).toContain('agent « Chercheur »');
    expect(last.system).toContain('Vérifie toujours la mémoire.');
    expect(last.system).toContain('- memory.search');
    expect(last.system).not.toContain('- memory.remember');
    expect(last.history[2]!.content).toContain("Résultat de l'outil memory.search (données)");
    expect(last.history[4]!.content).toContain('"result":42');
  });

  it('denies a tool the agent was not given, records it, and carries on', async () => {
    const a = await agent({ name: 'Lecteur', tools: ['clock.now'] });
    model.play(
      sequence(
        { tool: 'memory.remember', input: { content: 'Intrusion' } },
        { tool: 'sql.raw', input: { q: 'drop table' } },
        { tool: 'clock.now', input: { extra: true } },
        { final: 'Fait sans écrire' },
      ),
    );
    const id = await launch(a.id);
    const m = await until(id, (x) => x.status === 'completed');
    expect(m.tool_calls.map((c) => [c.tool, c.status, c.error])).toEqual([
      ['memory.remember', 'denied', 'not_allowed'],
      ['sql.raw', 'denied', 'unknown_tool'],
      ['clock.now', 'failed', 'invalid_input'],
    ]);
    const memories = (await call('GET', '/memories')).json<{ content: string }[]>();
    expect(memories.map((x) => x.content)).not.toContain('Intrusion');
    const history = model.agentCalls.at(-1)!.history;
    expect(history[2]!.content).toContain('outil non autorisé pour cet agent');
    expect(history[6]!.content).toContain('entrée invalide');
    const activity = (await call('GET', '/activity?limit=100')).json<
      { mission_id: string; kind: string }[]
    >();
    expect(activity.filter((x) => x.mission_id === id && x.kind === 'tool.denied')).toHaveLength(2);
  });

  it('pauses on a write tool until the user approves, then runs it', async () => {
    const a = await agent({ name: 'Scribe', tools: ['memory.remember'] });
    model.play(
      sequence(
        { tool: 'memory.remember', input: { content: 'Parle couramment italien', kind: 'fact' } },
        { final: 'Souvenir enregistré' },
      ),
    );
    const id = await launch(a.id);
    let m = await until(id, (x) => x.status === 'awaiting_approval' && !!pending(x));
    expect(pending(m)).toMatchObject({
      kind: 'tool',
      summary: 'Scribe veut : Retenir : « Parle couramment italien »',
    });
    expect(m.tool_calls.map((c) => c.status)).toEqual(['pending_approval']);
    const waiting = (await call('GET', '/approvals')).json<{ kind: string }[]>();
    expect(waiting.map((x) => x.kind)).toContain('tool');

    await call('POST', `/approvals/${pending(m)!.id}/decide`, { decision: 'approved' });
    m = await until(id, (x) => x.status === 'completed');
    expect(m.result).toBe('Souvenir enregistré');
    expect(m.tool_calls.map((c) => c.status)).toEqual(['succeeded']);
    const memories = (await call('GET', '/memories')).json<{ content: string; source: string }[]>();
    expect(memories).toContainEqual(
      expect.objectContaining({ content: 'Parle couramment italien', source: 'agent' }),
    );
    // After the pause, the step resumed with the call and its result replayed.
    expect(model.agentCalls.at(-1)!.history[2]!.content).toContain(
      "Résultat de l'outil memory.remember (données)",
    );
  });

  it('a refused tool call does not cancel the mission: the agent finishes without it', async () => {
    const a = await agent({ name: 'Scribe 2', tools: ['memory.remember'] });
    model.play(
      sequence(
        { tool: 'memory.remember', input: { content: 'À ne pas retenir' } },
        { final: 'Tant pis' },
      ),
    );
    const id = await launch(a.id);
    const m = await until(id, (x) => x.status === 'awaiting_approval' && !!pending(x));
    await call('POST', `/approvals/${pending(m)!.id}/decide`, { decision: 'rejected' });
    const done = await until(id, (x) => x.status === 'completed');
    expect(done.result).toBe('Tant pis');
    expect(done.tool_calls.map((c) => c.status)).toEqual(['rejected']);
    expect(model.agentCalls.at(-1)!.history[2]!.content).toContain("l'utilisateur a refusé");
  });

  it('lets an auto_write agent write without asking', async () => {
    const a = await agent({ name: 'Autonome', tools: ['memory.remember'], auto_write: true });
    model.play(
      sequence({ tool: 'memory.remember', input: { content: 'Joue du piano' } }, { final: 'OK' }),
    );
    const id = await launch(a.id);
    const m = await until(id, (x) => x.status === 'completed');
    expect(m.approvals.map((x) => x.kind)).toEqual(['plan']);
    expect(m.tool_calls.map((c) => c.status)).toEqual(['succeeded']);
  });

  it('applies a revoked tool at the very next call, mid-mission', async () => {
    const a = await agent({ name: 'Révoqué', tools: ['clock.now', 'memory.remember'] });
    model.play((history) => {
      const turn = (history.length - 1) / 2;
      if (turn === 0) return { tool: 'clock.now', input: {} };
      if (turn === 1) return { tool: 'memory.remember', input: { content: 'Avant' } };
      return { final: 'Terminé' };
    });
    const id = await launch(a.id);
    // Paused on memory.remember: the user revokes it instead of answering.
    const m = await until(id, (x) => x.status === 'awaiting_approval' && !!pending(x));
    await call('PATCH', `/agents/${a.id}`, { tools: ['clock.now'] });
    await call('POST', `/approvals/${pending(m)!.id}/decide`, { decision: 'approved' });
    const done = await until(id, (x) => x.status === 'completed');
    // Approved but no longer allowed: the database gate refused to run it, the agent went on.
    expect(done.tool_calls.map((c) => [c.tool, c.status])).toEqual([
      ['clock.now', 'succeeded'],
      ['memory.remember', 'denied'],
    ]);
    expect(model.agentCalls.at(-1)!.history[4]!.content).toContain('outil non autorisé');
    expect(done.result).toBe('Terminé');
    const memories = (await call('GET', '/memories')).json<{ content: string }[]>();
    expect(memories.map((x) => x.content)).not.toContain('Avant');
  });
});
