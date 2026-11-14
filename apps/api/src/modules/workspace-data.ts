import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';
import { requireAuth, type AuthContext } from '../plugins/auth.js';
import { defaultWorkspaceId } from './workspace.js';

/**
 * Projects, tasks, documents and events: shared by the members of a workspace.
 * RLS decides who sees what; the database checks links and values. Writes go to the
 * workspace given in the body, or the user's default workspace.
 */

const IdParams = z.object({ id: z.uuid() });
const WorkspaceRef = { workspace_id: z.uuid().optional() };
const ProjectRef = z.uuid().nullable();
const Instant = z.iso.datetime({ offset: true });
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

/** Database refusals the client can act on. */
function dbError(error: { code?: string; message: string } | null) {
  if (!error) return;
  if (error.code === '23514' || error.code === '22007' || error.code === '22008') {
    throw httpError(400, error.message);
  }
  if (error.code === '42501') throw httpError(403, 'Not a member of this workspace');
  throw error;
}

const nonEmpty = <T extends z.ZodObject>(schema: T) =>
  schema
    .partial()
    .strict()
    .refine((p) => Object.keys(p).length > 0, 'Nothing to update');

type Resource = {
  path: string;
  table: string;
  tag: string;
  label: string;
  columns: string;
  create: z.ZodType<Record<string, unknown>>;
  patch: z.ZodType<Record<string, unknown>>;
  list: (db: AuthContext['db'], req: FastifyRequest) => Promise<unknown>;
};

function resourceRoutes(app: FastifyInstance, r: Resource) {
  const docs = (summary: string) => ({ tags: [r.tag], summary, security: [{ bearer: [] }] });
  const notFound = () => httpError(404, `${r.label} not found`);

  app.get(r.path, { schema: docs(`List ${r.table}`) }, async (req) =>
    r.list(requireAuth(req).db, req),
  );

  app.get(`${r.path}/:id`, { schema: docs(`One of ${r.table}`) }, async (req) => {
    const { db } = requireAuth(req);
    const { id } = parse(IdParams, req.params);
    const { data, error } = await db.from(r.table).select(r.columns).eq('id', id).maybeSingle();
    dbError(error);
    if (!data) throw notFound();
    return data;
  });

  app.post(r.path, { schema: docs(`Create in ${r.table}`) }, async (req, reply) => {
    const { db, userId } = requireAuth(req);
    const body = parse(r.create, req.body);
    const workspace_id =
      (body.workspace_id as string | undefined) ?? (await defaultWorkspaceId(db, userId));
    const { data, error } = await db
      .from(r.table)
      .insert({ ...body, workspace_id })
      .select(r.columns)
      .single();
    dbError(error);
    return reply.status(201).send(data);
  });

  app.patch(`${r.path}/:id`, { schema: docs(`Edit in ${r.table}`) }, async (req) => {
    const { db } = requireAuth(req);
    const { id } = parse(IdParams, req.params);
    const patch = parse(r.patch, req.body);
    const { data, error } = await db
      .from(r.table)
      .update(patch)
      .eq('id', id)
      .select(r.columns)
      .maybeSingle();
    dbError(error);
    if (!data) throw notFound();
    return data;
  });

  app.delete(`${r.path}/:id`, { schema: docs(`Delete from ${r.table}`) }, async (req, reply) => {
    const { db } = requireAuth(req);
    const { id } = parse(IdParams, req.params);
    const { data, error } = await db.from(r.table).delete().eq('id', id).select('id');
    dbError(error);
    if (!data?.length) throw notFound();
    return reply.status(204).send();
  });
}

// ---------------------------------------------------------------- projects

const ProjectFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: OptionalText(2000),
  status: z.enum(['active', 'archived']),
});
const ProjectQuery = z
  .object({ status: z.enum(['active', 'archived', 'all']).default('active') })
  .strict();

// ---------------------------------------------------------------- tasks

const TASK_STATUS = ['todo', 'in_progress', 'done'] as const;
const TaskFields = z.object({
  title: z.string().trim().min(1).max(200),
  notes: OptionalText(4000),
  status: z.enum(TASK_STATUS),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  due_at: Instant.nullable(),
  project_id: ProjectRef,
});
const TaskQuery = z
  .object({
    status: z.enum([...TASK_STATUS, 'open', 'all']).default('open'),
    project_id: z.uuid().optional(),
    due_before: Instant.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

// ---------------------------------------------------------------- documents

const DocumentFields = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100_000),
  project_id: ProjectRef,
});
const DocumentQuery = z
  .object({ q: z.string().trim().min(1).max(500).optional(), project_id: z.uuid().optional() })
  .strict();

// ---------------------------------------------------------------- events

const EventFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: OptionalText(4000),
  location: OptionalText(200),
  starts_at: Instant,
  ends_at: Instant,
  all_day: z.boolean(),
  project_id: ProjectRef,
});
const EventQuery = z.object({ from: Instant.optional(), to: Instant.optional() }).strict();
const endsAfterStart = (e: { starts_at?: string; ends_at?: string }) =>
  !e.starts_at || !e.ends_at || new Date(e.ends_at) >= new Date(e.starts_at);

export async function workspaceDataRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  resourceRoutes(app, {
    path: '/projects',
    table: 'projects',
    tag: 'projects',
    label: 'Project',
    columns: 'id, workspace_id, name, description, status, created_at, updated_at',
    create: ProjectFields.partial({ description: true, status: true })
      .extend(WorkspaceRef)
      .strict(),
    patch: nonEmpty(ProjectFields),
    async list(db, req) {
      const { status } = parse(ProjectQuery, req.query);
      let q = db
        .from('projects')
        .select('id, workspace_id, name, description, status, created_at, updated_at')
        .order('updated_at', { ascending: false });
      if (status !== 'all') q = q.eq('status', status);
      const { data, error } = await q;
      dbError(error);
      return data;
    },
  });

  resourceRoutes(app, {
    path: '/tasks',
    table: 'tasks',
    tag: 'tasks',
    label: 'Task',
    columns:
      'id, workspace_id, project_id, title, notes, status, priority, due_at, completed_at, created_at, updated_at',
    create: TaskFields.partial({
      notes: true,
      status: true,
      priority: true,
      due_at: true,
      project_id: true,
    })
      .extend(WorkspaceRef)
      .strict(),
    patch: nonEmpty(TaskFields),
    async list(db, req) {
      const query = parse(TaskQuery, req.query);
      let q = db
        .from('tasks')
        .select(
          'id, workspace_id, project_id, title, notes, status, priority, due_at, completed_at, created_at, updated_at',
        )
        .order('due_at', { ascending: true, nullsFirst: false })
        .order('created_at')
        .limit(query.limit);
      if (query.status === 'open') q = q.neq('status', 'done');
      else if (query.status !== 'all') q = q.eq('status', query.status);
      if (query.project_id) q = q.eq('project_id', query.project_id);
      if (query.due_before) q = q.lte('due_at', query.due_before);
      const { data, error } = await q;
      dbError(error);
      // Due date first; among tasks due together (or without date), the most urgent first.
      return (data ?? []).sort(
        (a, b) =>
          (a.due_at ?? '￿').localeCompare(b.due_at ?? '￿') ||
          PRIORITY_RANK[a.priority as keyof typeof PRIORITY_RANK] -
            PRIORITY_RANK[b.priority as keyof typeof PRIORITY_RANK],
      );
    },
  });

  resourceRoutes(app, {
    path: '/documents',
    table: 'documents',
    tag: 'documents',
    label: 'Document',
    columns: 'id, workspace_id, project_id, title, content, created_at, updated_at',
    create: DocumentFields.partial({ content: true, project_id: true })
      .extend(WorkspaceRef)
      .strict(),
    patch: nonEmpty(DocumentFields),
    async list(db, req) {
      const { q, project_id } = parse(DocumentQuery, req.query);
      if (q) {
        const { data, error } = await db.rpc('search_documents', { q, max_rows: 50 });
        dbError(error);
        return data;
      }
      // The list never ships full contents: an excerpt is enough.
      let query = db
        .from('documents')
        .select('id, workspace_id, project_id, title, content, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (project_id) query = query.eq('project_id', project_id);
      const { data, error } = await query;
      dbError(error);
      return (data ?? []).map(({ content, ...d }) => ({
        ...d,
        excerpt: content.slice(0, 200),
        length: content.length,
      }));
    },
  });

  resourceRoutes(app, {
    path: '/events',
    table: 'events',
    tag: 'calendar',
    label: 'Event',
    columns:
      'id, workspace_id, project_id, title, description, location, starts_at, ends_at, all_day, created_at, updated_at',
    create: EventFields.partial({
      description: true,
      location: true,
      all_day: true,
      project_id: true,
    })
      .extend(WorkspaceRef)
      .strict()
      .refine(endsAfterStart, 'ends_at must not be before starts_at'),
    patch: nonEmpty(EventFields).refine(endsAfterStart, 'ends_at must not be before starts_at'),
    async list(db, req) {
      const { from, to } = parse(EventQuery, req.query);
      const start = from ?? new Date(Date.now() - 86_400_000).toISOString();
      const end = to ?? new Date(Date.parse(start) + 31 * 86_400_000).toISOString();
      if (end < start) throw httpError(400, 'to must not be before from');
      const { data, error } = await db
        .from('events')
        .select(
          'id, workspace_id, project_id, title, description, location, starts_at, ends_at, all_day, created_at, updated_at',
        )
        .gte('ends_at', start)
        .lt('starts_at', end)
        .order('starts_at')
        .limit(500);
      dbError(error);
      return data;
    },
  });
}
