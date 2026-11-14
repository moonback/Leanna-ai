import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';
import { requireAuth } from '../plugins/auth.js';
import { MEMORY_KINDS } from '../memory/extract.js';
import { MEMORY_COLUMNS, toMemory, type MemoryRow, type MemoryService } from '../memory/service.js';
import { defaultWorkspaceId } from './workspace.js';

const IdParams = z.object({ id: z.uuid() });
const ListQuery = z
  .object({
    status: z.enum(['active', 'superseded']).default('active'),
    q: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const Content = z.string().trim().min(1).max(500);
const CreateBody = z
  .object({
    content: Content,
    kind: z.enum(MEMORY_KINDS).default('fact'),
    importance: z.number().int().min(1).max(5).default(3),
  })
  .strict();
const PatchBody = z
  .object({
    content: Content,
    kind: z.enum(MEMORY_KINDS),
    importance: z.number().int().min(1).max(5),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to update');
const ClearBody = z.object({ confirm: z.literal(true) }).strict();

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function memoryRoutes(app: FastifyInstance, opts: { memory: MemoryService }) {
  const { memory } = opts;
  const { embedder } = memory;
  app.addHook('preHandler', app.authenticate);
  const docs = (summary: string) => ({ tags: ['memory'], summary, security: [{ bearer: [] }] });

  app.get(
    '/memories',
    { schema: docs('List my memories, or search them (hybrid lexical + semantic) with q') },
    async (req) => {
      const { db } = requireAuth(req);
      const { status, q } = parse(ListQuery, req.query);
      if (q && status === 'active') {
        const hits = await memory.recall(db, q, 20);
        if (!hits.length) return [];
        const { data, error } = await db
          .from('memories')
          .select(MEMORY_COLUMNS)
          .in(
            'id',
            hits.map((h) => h.id),
          );
        if (error) throw error;
        const byId = new Map((data as MemoryRow[]).map((r) => [r.id, r]));
        return hits.flatMap((h) => {
          const row = byId.get(h.id);
          return row ? [{ ...toMemory(row, embedder), score: h.score }] : [];
        });
      }
      let query = db
        .from('memories')
        .select(MEMORY_COLUMNS)
        .eq('status', status)
        .order('updated_at', { ascending: false })
        .limit(500);
      if (q) query = query.ilike('content', `%${q.replace(/[%_\\]/g, '\\$&')}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data as MemoryRow[]).map((r) => toMemory(r, embedder));
    },
  );

  app.post('/memories', { schema: docs('Teach LEANA something') }, async (req, reply) => {
    const { db, userId } = requireAuth(req);
    const body = parse(CreateBody, req.body);

    const same = await db
      .from('memories')
      .select('id, content')
      .eq('status', 'active')
      .ilike('content', body.content.replace(/[%_\\]/g, '\\$&'));
    if (same.error) throw same.error;
    if (same.data.some((m) => normalize(m.content) === normalize(body.content))) {
      throw httpError(409, 'LEANA already knows this');
    }

    const [row] = await memory.insert(db, [
      { ...body, workspace_id: await defaultWorkspaceId(db, userId), source: 'manual' },
    ]);
    return reply.status(201).send(toMemory(row!, embedder));
  });

  app.patch('/memories/:id', { schema: docs('Correct a memory') }, async (req) => {
    const { db } = requireAuth(req);
    const { id } = parse(IdParams, req.params);
    const patch = parse(PatchBody, req.body);
    const { data, error } = await db
      .from('memories')
      .update(patch)
      .eq('id', id)
      .select(MEMORY_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw httpError(404, 'Memory not found');
    const row = data as MemoryRow;
    // The database dropped the vector if the text changed.
    return toMemory(row.embedding_model ? row : await memory.reembed(db, row), embedder);
  });

  app.post(
    '/memories/:id/restore',
    { schema: docs('Make a replaced or forgotten memory active again') },
    async (req) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const { data, error } = await db
        .from('memories')
        .update({ status: 'active', superseded_by: null })
        .eq('id', id)
        .select(MEMORY_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw httpError(404, 'Memory not found');
      return toMemory(data as MemoryRow, embedder);
    },
  );

  app.delete('/memories/:id', { schema: docs('Delete a memory') }, async (req, reply) => {
    const { db } = requireAuth(req);
    const { id } = parse(IdParams, req.params);
    const { data, error } = await db.from('memories').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data.length) throw httpError(404, 'Memory not found');
    return reply.status(204).send();
  });

  app.delete(
    '/memories',
    { schema: docs('Delete all my memories (body: {"confirm": true})') },
    async (req) => {
      const { db, userId } = requireAuth(req);
      parse(ClearBody, req.body);
      const { data, error } = await db.from('memories').delete().eq('user_id', userId).select('id');
      if (error) throw error;
      return { deleted: data.length };
    },
  );

  app.post(
    '/memories/reindex',
    { schema: docs('Compute missing embeddings (after a model change or an outage)') },
    async (req) => {
      const { db } = requireAuth(req);
      if (!embedder) throw httpError(503, 'Embeddings not configured');
      return memory.reindex(db);
    },
  );
}
