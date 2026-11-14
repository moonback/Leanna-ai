// Requires the local Supabase stack (and Redis for the agent scenario). Real API and
// database; the model is scripted. CRUD, validation and isolation of projects, tasks,
// documents and events, then an agent that organises them through its tools.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { createAiGateway } from '../src/ai/setup.js';
import type { AiProvider, StreamEvent, StreamRequest } from '../src/ai/types.js';
import { PLAN_SYSTEM } from '../src/missions/plan.js';
import { startMissionWorker, type MissionWorker } from '../src/missions/worker.js';
import { signUp } from './helpers.js';

const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  GEMINI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  MISSIONS_QUEUE: `test-workspace-${randomUUID()}`,
});
const silent = { info() {}, warn() {}, error() {} };

let replies: object[] = [];
const model: AiProvider = {
  name: 'test-double',
  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    if (req.system.startsWith(PLAN_SYSTEM)) {
      yield {
        type: 'text',
        text: JSON.stringify({ steps: [{ title: 'Organiser', instruction: 'Avec les outils' }] }),
      };
      return;
    }
    yield {
      type: 'text',
      text: JSON.stringify(replies[Math.min((req.history.length - 1) / 2, replies.length - 1)]),
    };
  },
};

type Row = Record<string, unknown> & { id: string };

describe('projects, tasks, documents, events (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;
  let sql: postgres.Sql;
  let worker: MissionWorker;

  beforeAll(async () => {
    app = await buildApp(env, { aiProviders: { gemini: model }, embedder: null });
    [alice, bob] = await Promise.all([signUp(env, 'Alice'), signUp(env, 'Bob')]);
    sql = postgres(env.DATABASE_URL!, {
      max: 4,
      connection: { role: 'leana_worker' },
      onnotice: () => {},
    });
    worker = startMissionWorker({
      env,
      sql,
      gateway: createAiGateway(env, silent, { gemini: model }).gateway,
      log: silent,
    });
  });
  afterAll(async () => {
    await worker.close(true);
    await app.close();
    await sql.end({ timeout: 1 });
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    who = alice,
  ) => app.inject({ method, url, headers: who.auth, ...(payload && { payload }) });
  const create = async (path: string, body: object, who = alice) => {
    const res = await call('POST', path, body, who);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Row>();
  };
  const in_ = (days: number, hours = 0) =>
    new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();

  it('manages projects and tasks, ordered by due date then urgency', async () => {
    const project = await create('/projects', { name: 'Déménagement', description: 'Juin' });
    expect(project).toMatchObject({ name: 'Déménagement', status: 'active' });

    const later = await create('/tasks', { title: 'Cartons', due_at: in_(5) });
    const urgent = await create('/tasks', {
      title: 'Résilier le bail',
      priority: 'urgent',
      due_at: in_(1),
      project_id: project.id,
    });
    const normal = await create('/tasks', { title: 'Prévenir la banque', due_at: in_(1) });
    await create('/tasks', { title: 'Sans date' });
    expect(urgent).toMatchObject({ status: 'todo', priority: 'urgent' });

    const open = (await call('GET', '/tasks')).json<Row[]>();
    expect(open.map((t) => t.title)).toEqual([
      'Résilier le bail',
      'Prévenir la banque',
      'Cartons',
      'Sans date',
    ]);
    expect(normal.priority).toBe('normal');

    // Completing sets completed_at; done tasks leave the default (open) list.
    const done = await call('PATCH', `/tasks/${later.id}`, { status: 'done' });
    expect(done.json()).toMatchObject({ status: 'done', completed_at: expect.any(String) });
    expect((await call('GET', '/tasks')).json<Row[]>().map((t) => t.title)).not.toContain(
      'Cartons',
    );
    expect((await call('GET', '/tasks?status=done')).json<Row[]>().map((t) => t.title)).toEqual([
      'Cartons',
    ]);
    const reopened = await call('PATCH', `/tasks/${later.id}`, { status: 'todo' });
    expect(reopened.json()).toMatchObject({ completed_at: null });

    const byProject = (await call('GET', `/tasks?project_id=${project.id}`)).json<Row[]>();
    expect(byProject.map((t) => t.title)).toEqual(['Résilier le bail']);

    // Archiving hides a project from the default list; deleting keeps its tasks.
    await call('PATCH', `/projects/${project.id}`, { status: 'archived' });
    expect((await call('GET', '/projects')).json<Row[]>().map((p) => p.id)).not.toContain(
      project.id,
    );
    expect((await call('DELETE', `/projects/${project.id}`)).statusCode).toBe(204);
    expect((await call('GET', `/tasks/${urgent.id}`)).json()).toMatchObject({ project_id: null });
  });

  it('validates input and database rules', async () => {
    expect((await call('POST', '/tasks', { title: '' })).statusCode).toBe(400);
    expect((await call('POST', '/tasks', { title: 'x', priority: 'critique' })).statusCode).toBe(
      400,
    );
    expect((await call('POST', '/tasks', { title: 'x', due_at: 'demain' })).statusCode).toBe(400);
    expect((await call('PATCH', '/tasks/not-a-uuid', { title: 'x' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/events', { title: 'x', starts_at: in_(2), ends_at: in_(1) }))
        .statusCode,
    ).toBe(400);
    // A project of another workspace is refused by the database.
    const bobsProject = await create('/projects', { name: 'Projet de Bob' }, bob);
    const res = await call('POST', '/tasks', { title: 'x', project_id: bobsProject.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('same workspace');
    // A workspace the caller is not a member of.
    const bobMe = (await call('GET', '/me', undefined, bob)).json<{
      workspaces: { id: string }[];
    }>();
    const intrusion = await call('POST', '/tasks', {
      title: 'x',
      workspace_id: bobMe.workspaces[0]!.id,
    });
    expect(intrusion.statusCode).toBe(403);
  });

  it('keeps each workspace private', async () => {
    const secret = await create('/tasks', { title: 'Secret de Bob' }, bob);
    const doc = await create('/documents', { title: 'Journal de Bob', content: 'privé' }, bob);
    expect((await call('GET', '/tasks?status=all')).json<Row[]>().map((t) => t.id)).not.toContain(
      secret.id,
    );
    expect((await call('GET', `/tasks/${secret.id}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/tasks/${secret.id}`, { title: 'piraté' })).statusCode).toBe(404);
    expect((await call('DELETE', `/documents/${doc.id}`)).statusCode).toBe(404);
    expect((await call('GET', '/documents?q=privé')).json()).toEqual([]);
  });

  it('stores documents, lists excerpts and searches their text', async () => {
    const long = `Inventaire du salon : canapé, bibliothèque, vaisselle fragile. ${'x'.repeat(400)}`;
    const doc = await create('/documents', { title: 'Inventaire', content: long });
    const list = (await call('GET', '/documents')).json<Row[]>();
    const item = list.find((d) => d.id === doc.id)!;
    expect(item).toMatchObject({ title: 'Inventaire', length: long.length });
    expect(item).not.toHaveProperty('content');
    expect((item.excerpt as string).length).toBe(200);
    expect((await call('GET', `/documents/${doc.id}`)).json()).toMatchObject({ content: long });

    const hits = (await call('GET', '/documents?q=vaisselles')).json<Row[]>();
    expect(hits[0]).toMatchObject({ id: doc.id, title: 'Inventaire' });
    expect(hits[0]!.snippet).toContain('«vaisselle»');
    await call('PATCH', `/documents/${doc.id}`, { content: 'Plus que des plantes' });
    expect(
      (await call('GET', '/documents?q=vaisselle')).json<Row[]>().map((d) => d.id),
    ).not.toContain(doc.id);
  });

  it('lists events overlapping a time range', async () => {
    const soon = await create('/events', {
      title: 'Camion',
      starts_at: in_(2),
      ends_at: in_(2, 4),
      location: 'Lyon',
    });
    await create('/events', { title: 'Lointain', starts_at: in_(60), ends_at: in_(60, 1) });
    const week = (
      await call(
        'GET',
        `/events?from=${encodeURIComponent(in_(0))}&to=${encodeURIComponent(in_(7))}`,
      )
    ).json<Row[]>();
    expect(week.map((e) => e.title)).toEqual(['Camion']);
    expect(week[0]).toMatchObject({ id: soon.id, location: 'Lyon', all_day: false });
    const moved = await call('PATCH', `/events/${soon.id}`, {
      starts_at: in_(3),
      ends_at: in_(3, 2),
    });
    expect(moved.statusCode).toBe(200);
    expect(
      (await call('PATCH', `/events/${soon.id}`, { starts_at: in_(4), ends_at: in_(3) }))
        .statusCode,
    ).toBe(400);
  });

  it('an agent organises the workspace through its tools', async () => {
    await create('/documents', { title: 'Notes du chantier', content: 'Le plombier passe jeudi.' });
    const agent = (
      await call('POST', '/agents', {
        name: 'Organisateur',
        tools: ['tasks.create', 'tasks.list', 'documents.search', 'calendar.create'],
        auto_write: true,
      })
    ).json<{ id: string }>();
    const due = in_(2);
    replies = [
      { tool: 'documents.search', input: { query: 'plombier' } },
      {
        tool: 'tasks.create',
        input: { title: 'Appeler le plombier', priority: 'high', due_at: due },
      },
      {
        tool: 'calendar.create',
        input: { title: 'Plombier', starts_at: in_(3), ends_at: in_(3, 1) },
      },
      { tool: 'tasks.list', input: {} },
      { final: 'Tâche et rendez-vous créés' },
    ];
    const id = (
      await call('POST', '/missions', { goal: 'Organise le chantier', agent_id: agent.id })
    ).json<{ id: string }>().id;

    const until = async (ok: (m: Row) => boolean) => {
      for (let i = 0; i < 150; i++) {
        const m = (await call('GET', `/missions/${id}`)).json<Row>();
        if (ok(m)) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('timeout');
    };
    const waiting = await until((m) => m.status === 'awaiting_approval');
    const plan = (waiting.approvals as Row[])[0]!;
    await call('POST', `/approvals/${plan.id}/decide`, { decision: 'approved' });
    const m = await until((x) => x.status === 'completed');

    const calls = m.tool_calls as {
      tool: string;
      status: string;
      output: Record<string, unknown>;
    }[];
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ['documents.search', 'succeeded'],
      ['tasks.create', 'succeeded'],
      ['calendar.create', 'succeeded'],
      ['tasks.list', 'succeeded'],
    ]);
    expect((calls[0]!.output.documents as Row[])[0]).toMatchObject({ title: 'Notes du chantier' });
    const listed = (calls[3]!.output.tasks as Row[]).map((t) => t.title);
    expect(listed).toContain('Appeler le plombier');

    const tasks = (await call('GET', '/tasks')).json<Row[]>();
    expect(tasks.find((t) => t.title === 'Appeler le plombier')).toMatchObject({
      priority: 'high',
      due_at: expect.any(String),
    });
    const events = (await call('GET', '/events')).json<Row[]>();
    expect(events.map((e) => e.title)).toContain('Plombier');
  });
});
