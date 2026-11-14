import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';
import { requireAuth } from '../plugins/auth.js';
import type { Gateway } from '../ai/gateway.js';
import type { MissionQueue } from '../missions/queue.js';
import { defaultWorkspaceId } from './workspace.js';

export type MissionOptions = {
  gateway: Gateway | null;
  queue: MissionQueue | null;
  dailyTokenLimit: number;
};

const IdParams = z.object({ id: z.uuid() });
const CreateBody = z
  .object({
    goal: z.string().trim().min(1).max(4000),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
const DecideBody = z.object({ decision: z.enum(['approved', 'rejected']) }).strict();
const ListApprovals = z.object({ status: z.enum(['pending', 'all']).default('pending') }).strict();
const ListActivity = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
const MarkRead = z
  .object({ ids: z.array(z.uuid()).min(1).max(200).optional(), all: z.literal(true).optional() })
  .strict()
  .refine((b) => !!b.ids !== !!b.all, 'Send either ids or all');

const MISSION_COLUMNS =
  'id, title, goal, status, provider, model, result, error_code, created_at, updated_at, finished_at';
const STEP_COLUMNS =
  'id, position, title, instruction, requires_approval, status, attempt, output, error_code, started_at, finished_at';
const APPROVAL_COLUMNS = 'id, mission_id, step_id, kind, summary, status, decided_at, created_at';

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

/** A database refusal of a transition (finished mission, decided approval) is a 409. */
function conflict(error: { code?: string; message: string } | null) {
  if (error?.code === '23514') throw httpError(409, error.message);
  if (error) throw error;
}

export async function missionRoutes(app: FastifyInstance, opts: MissionOptions) {
  const { gateway, queue } = opts;
  app.addHook('preHandler', app.authenticate);
  const docs = (tag: string, summary: string) => ({
    tags: [tag],
    summary,
    security: [{ bearer: [] }],
  });

  /** Wake the worker. A failure is logged: the worker's sweep recovers lost jobs. */
  const wake = async (missionId: string, log: FastifyInstance['log']) => {
    try {
      await queue!.enqueue(missionId);
    } catch (err) {
      log.error(err, 'failed to enqueue mission (the recovery sweep will pick it up)');
    }
  };

  app.get('/missions/config', { schema: docs('missions', 'Can missions run here?') }, async () => ({
    configured: !!queue && !!gateway,
  }));

  app.get('/missions', { schema: docs('missions', 'My missions, newest first') }, async (req) => {
    const { db } = requireAuth(req);
    const { data, error } = await db
      .from('missions')
      .select(MISSION_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return data;
  });

  app.post(
    '/missions',
    { schema: docs('missions', 'Give LEANA a goal: she plans it, you approve, she runs it') },
    async (req, reply) => {
      const { db, userId } = requireAuth(req);
      const body = parse(CreateBody, req.body);
      if (!queue || !gateway) throw httpError(503, 'Missions not configured');

      const since = new Date(Date.now() - 86_400_000).toISOString();
      const [used, prefs] = await Promise.all([
        db.rpc('ai_tokens_used_since', { since }),
        db.from('preferences').select('settings').eq('user_id', userId).single(),
      ]);
      if (used.error) throw used.error;
      if (prefs.error) throw prefs.error;
      if (Number(used.data) >= opts.dailyTokenLimit) throw httpError(429, 'Daily AI quota reached');

      const { provider, model } = gateway.resolve(prefs.data.settings);
      const title = body.title ?? body.goal.replace(/\s+/g, ' ').slice(0, 80);
      const { data, error } = await db
        .from('missions')
        .insert({
          workspace_id: await defaultWorkspaceId(db, userId),
          goal: body.goal,
          title,
          provider,
          model,
        })
        .select(MISSION_COLUMNS)
        .single();
      if (error) throw error;
      await wake(data.id, req.log);
      return reply.status(201).send(data);
    },
  );

  app.get(
    '/missions/:id',
    { schema: docs('missions', 'A mission with its plan, results and approvals') },
    async (req) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const [mission, steps, approvals] = await Promise.all([
        db.from('missions').select(MISSION_COLUMNS).eq('id', id).maybeSingle(),
        db.from('mission_steps').select(STEP_COLUMNS).eq('mission_id', id).order('position'),
        db.from('approvals').select(APPROVAL_COLUMNS).eq('mission_id', id).order('created_at'),
      ]);
      for (const r of [mission, steps, approvals]) if (r.error) throw r.error;
      if (!mission.data) throw httpError(404, 'Mission not found');
      return { ...mission.data, steps: steps.data, approvals: approvals.data };
    },
  );

  app.post(
    '/missions/:id/cancel',
    { schema: docs('missions', 'Stop a mission (the current step is discarded)') },
    async (req) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const { data, error } = await db
        .from('missions')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .select(MISSION_COLUMNS)
        .maybeSingle();
      conflict(error);
      if (!data) throw httpError(404, 'Mission not found');
      return data;
    },
  );

  app.get(
    '/approvals',
    { schema: docs('missions', 'Decisions LEANA is waiting for') },
    async (req) => {
      const { db } = requireAuth(req);
      const { status } = parse(ListApprovals, req.query);
      let query = db
        .from('approvals')
        .select(`${APPROVAL_COLUMNS}, mission:missions!inner(title)`)
        .order('created_at', { ascending: false })
        .limit(100);
      if (status === 'pending') query = query.eq('status', 'pending');
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  );

  app.post(
    '/approvals/:id/decide',
    { schema: docs('missions', 'Approve or reject a plan or a step') },
    async (req) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const { decision } = parse(DecideBody, req.body);
      const { data, error } = await db
        .from('approvals')
        .update({ status: decision })
        .eq('id', id)
        .select(APPROVAL_COLUMNS)
        .maybeSingle();
      conflict(error);
      if (!data) throw httpError(404, 'Approval not found');
      // A refusal stops the mission now; an approval lets the worker carry on.
      if (decision === 'rejected') {
        const cancel = await db
          .from('missions')
          .update({ status: 'cancelled' })
          .eq('id', data.mission_id)
          .eq('status', 'awaiting_approval');
        if (cancel.error) throw cancel.error;
      } else if (queue) {
        await wake(data.mission_id, req.log);
      }
      return data;
    },
  );

  app.get('/activity', { schema: docs('activity', 'What happened, newest first') }, async (req) => {
    const { db } = requireAuth(req);
    const { limit } = parse(ListActivity, req.query);
    const { data, error } = await db
      .from('activity')
      .select('id, mission_id, kind, summary, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  });

  app.get(
    '/notifications',
    { schema: docs('activity', 'Notifications and the unread count') },
    async (req) => {
      const { db } = requireAuth(req);
      const [items, unread] = await Promise.all([
        db
          .from('notifications')
          .select('id, title, link, read_at, created_at')
          .order('created_at', { ascending: false })
          .limit(50),
        db.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
      ]);
      if (items.error) throw items.error;
      if (unread.error) throw unread.error;
      return { items: items.data, unread: unread.count ?? 0 };
    },
  );

  app.post(
    '/notifications/read',
    { schema: docs('activity', 'Mark notifications read (ids, or all)') },
    async (req) => {
      const { db } = requireAuth(req);
      const body = parse(MarkRead, req.body);
      let query = db
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .is('read_at', null);
      if (body.ids) query = query.in('id', body.ids);
      const { data, error } = await query.select('id');
      if (error) throw error;
      return { marked: data.length };
    },
  );
}
