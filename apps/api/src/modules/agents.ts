import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';
import { requireAuth } from '../plugins/auth.js';
import type { Gateway } from '../ai/gateway.js';
import { PROVIDER_IDS } from '../ai/types.js';
import { inputSchema, TOOLS, TOOLS_BY_NAME } from '../tools/registry.js';
import { defaultWorkspaceId } from './workspace.js';

const IdParams = z.object({ id: z.uuid() });
const AgentFields = z.object({
  name: z.string().trim().min(1).max(60),
  description: z
    .string()
    .trim()
    .max(300)
    .transform((v) => v || null)
    .nullable(),
  instructions: z.string().trim().max(4000),
  tools: z
    .array(z.string())
    .max(20)
    .refine((list) => list.every((t) => TOOLS_BY_NAME.has(t)), 'Unknown tool'),
  auto_write: z.boolean(),
  provider: z.enum(PROVIDER_IDS).nullable(),
  model: z.string().min(1).max(100).nullable(),
});
const CreateBody = AgentFields.partial().required({ name: true }).strict();
const PatchBody = AgentFields.partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to update');

const AGENT_COLUMNS =
  'id, name, description, instructions, tools, auto_write, provider, model, created_at, updated_at';

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

export async function agentRoutes(app: FastifyInstance, opts: { gateway: Gateway | null }) {
  const { gateway } = opts;
  app.addHook('preHandler', app.authenticate);
  const docs = (summary: string) => ({ tags: ['agents'], summary, security: [{ bearer: [] }] });

  /** Same rule as /me/preferences: a model must be configured and allowlisted. */
  function checkModel(provider: string | null | undefined, model: string | null | undefined) {
    if (provider === undefined && model === undefined) return;
    if (!provider && model) throw httpError(400, 'Choose a provider before a model');
    if (provider && !model) throw httpError(400, 'Choose a model for this provider');
    if (provider && !gateway?.isAllowed({ provider: provider as never, model: model! })) {
      throw httpError(400, 'This model is not available on this server');
    }
  }

  app.get('/tools', { schema: docs('The tools an agent may be given') }, async () =>
    TOOLS.map((t) => ({
      name: t.name,
      risk: t.risk,
      description: t.description,
      input: inputSchema(t),
    })),
  );

  app.get('/agents', { schema: docs('My agents') }, async (req) => {
    const { db } = requireAuth(req);
    const { data, error } = await db
      .from('agents')
      .select(AGENT_COLUMNS)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data;
  });

  app.get('/agents/:id', { schema: docs('One agent') }, async (req) => {
    const { db } = requireAuth(req);
    const { id } = parse(IdParams, req.params);
    const { data, error } = await db
      .from('agents')
      .select(AGENT_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw httpError(404, 'Agent not found');
    return data;
  });

  app.post('/agents', { schema: docs('Create an agent') }, async (req, reply) => {
    const { db, userId } = requireAuth(req);
    const body = parse(CreateBody, req.body);
    checkModel(body.provider, body.model);
    const { data, error } = await db
      .from('agents')
      .insert({ ...body, workspace_id: await defaultWorkspaceId(db, userId) })
      .select(AGENT_COLUMNS)
      .single();
    if (error) throw error;
    return reply.status(201).send(data);
  });

  app.patch(
    '/agents/:id',
    { schema: docs('Edit an agent (takes effect at its next tool call)') },
    async (req) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const patch = parse(PatchBody, req.body);
      if ('provider' in patch || 'model' in patch) {
        if (!('provider' in patch && 'model' in patch)) {
          throw httpError(400, 'provider and model go together');
        }
        checkModel(patch.provider, patch.model);
      }
      const { data, error } = await db
        .from('agents')
        .update(patch)
        .eq('id', id)
        .select(AGENT_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw httpError(404, 'Agent not found');
      return data;
    },
  );

  app.delete(
    '/agents/:id',
    { schema: docs('Delete an agent (its missions lose its tools)') },
    async (req, reply) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const { data, error } = await db.from('agents').delete().eq('id', id).select('id');
      if (error) throw error;
      if (!data.length) throw httpError(404, 'Agent not found');
      return reply.status(204).send();
    },
  );
}
