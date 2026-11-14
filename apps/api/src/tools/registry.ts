import { z } from 'zod';
import type { Sql } from 'postgres';
import type { Embedder } from '../ai/embeddings.js';
import { MEMORY_KINDS } from '../memory/extract.js';
import { calculate, CalcError } from './calculator.js';

/**
 * Typed tool registry. Agents never get SQL or arbitrary code: only these tools, each with
 * a zod input schema, a risk level and an implementation that reaches user data solely
 * through `private.tool_*` functions bound to the running call (see the agents migration).
 * The `tools` table is the database mirror of this list; a test keeps both identical.
 */
export type ToolRisk = 'read' | 'write' | 'sensitive';

export type ToolContext = {
  sql: Sql;
  callId: string;
  timezone: string;
  embedder: Embedder | null;
  maxDistance: number;
};

export class ToolError extends Error {}

type ToolDef<S extends z.ZodType> = {
  name: string;
  risk: ToolRisk;
  description: string;
  input: S;
  /** One line shown to the user in an approval request. */
  describe: (input: z.infer<S>) => string;
  run: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
};

const define = <S extends z.ZodType>(def: ToolDef<S>) => def;
const vectorLiteral = (v: number[]) => `[${v.join(',')}]`;

async function embedOrNull(ctx: ToolContext, text: string, kind: 'query' | 'document') {
  if (!ctx.embedder) return null;
  try {
    const { vectors } = await ctx.embedder.embed([text], kind, AbortSignal.timeout(10_000));
    return vectorLiteral(vectors[0]!);
  } catch {
    return null; // lexical only, like chat recall
  }
}

export const TOOLS = [
  define({
    name: 'clock.now',
    risk: 'read',
    description: "Date et heure actuelles dans le fuseau horaire de l'utilisateur.",
    input: z.object({}).strict(),
    describe: () => 'Lire la date et l’heure',
    async run(ctx) {
      const now = new Date();
      return {
        iso: now.toISOString(),
        local: new Intl.DateTimeFormat('fr-FR', {
          dateStyle: 'full',
          timeStyle: 'short',
          timeZone: ctx.timezone,
        }).format(now),
        timezone: ctx.timezone,
      };
    },
  }),
  define({
    name: 'math.calculate',
    risk: 'read',
    description: 'Évalue une expression arithmétique (+ - * / % ^, parenthèses, décimales).',
    input: z.object({ expression: z.string().min(1).max(200) }).strict(),
    describe: (i) => `Calculer ${i.expression}`,
    async run(_ctx, { expression }) {
      try {
        return { expression, result: calculate(expression) };
      } catch (err) {
        if (err instanceof CalcError) throw new ToolError(err.message);
        throw err;
      }
    },
  }),
  define({
    name: 'memory.search',
    risk: 'read',
    description:
      "Recherche hybride (mots-clés et sens) dans les souvenirs actifs de l'utilisateur.",
    input: z
      .object({
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(10).default(5),
      })
      .strict(),
    describe: (i) => `Chercher « ${i.query} » dans la mémoire`,
    async run(ctx, { query, limit }) {
      const vector = await embedOrNull(ctx, query, 'query');
      const rows = await ctx.sql<{ id: string; kind: string; content: string }[]>`
        select id, kind, content from private.tool_memory_search(
          ${ctx.callId}, ${query}, ${vector},
          ${vector ? ctx.embedder!.model : null}, ${limit}, ${ctx.maxDistance})`;
      return { memories: rows.map((r) => ({ id: r.id, kind: r.kind, content: r.content })) };
    },
  }),
  define({
    name: 'memory.remember',
    risk: 'write',
    description: "Ajoute un souvenir durable sur l'utilisateur.",
    input: z
      .object({
        content: z.string().trim().min(1).max(500),
        kind: z.enum(MEMORY_KINDS).default('fact'),
        importance: z.number().int().min(1).max(5).default(3),
      })
      .strict(),
    describe: (i) => `Retenir : « ${i.content} »`,
    async run(ctx, { content, kind, importance }) {
      const vector = await embedOrNull(ctx, content, 'document');
      const [row] = await ctx.sql<{ id: string }[]>`
        select private.tool_memory_remember(
          ${ctx.callId}, ${kind}, ${content}, ${importance}::smallint,
          ${vector}, ${vector ? ctx.embedder!.model : null}) as id`;
      return { id: row!.id, remembered: content };
    },
  }),
  define({
    name: 'memory.forget',
    risk: 'write',
    description: 'Archive un souvenir (restaurable depuis la page Mémoire).',
    input: z.object({ memory_id: z.uuid() }).strict(),
    describe: (i) => `Oublier le souvenir ${i.memory_id}`,
    async run(ctx, { memory_id }) {
      const [row] = await ctx.sql<{ forgotten: boolean }[]>`
        select private.tool_memory_forget(${ctx.callId}, ${memory_id}) as forgotten`;
      if (!row!.forgotten) throw new ToolError('Souvenir introuvable ou déjà archivé');
      return { forgotten: memory_id };
    },
  }),
];

export type Tool = (typeof TOOLS)[number];
export const TOOLS_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

/** JSON Schema of a tool's input, for the model's tool list and the API. */
export const inputSchema = (tool: Tool) =>
  z.toJSONSchema(tool.input, { target: 'draft-07', io: 'input' });

/** Whether running this tool needs the user's approval for this agent. */
export const needsApproval = (tool: Pick<Tool, 'risk'>, autoWrite: boolean) =>
  tool.risk === 'sensitive' || (tool.risk === 'write' && !autoWrite);
