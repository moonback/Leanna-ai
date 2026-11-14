import type { FastifyBaseLogger } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Embedder, EmbedKind } from '../ai/embeddings.js';
import type { AiChoice, Gateway } from '../ai/gateway.js';
import type { ProviderId } from '../ai/types.js';
import {
  EXTRACTION_SYSTEM,
  extractionInput,
  parseOperations,
  type MemoryKind,
  type MemoryOperation,
  type RecalledMemory,
} from './extract.js';

export const MEMORY_COLUMNS =
  'id, kind, content, importance, source, source_message_id, status, superseded_by, embedding_model, created_at, updated_at';

export type MemoryRow = {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  source: 'manual' | 'conversation';
  source_message_id: string | null;
  status: 'active' | 'superseded';
  superseded_by: string | null;
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
};

/** Public shape: whether the row has a vector of the current model, never the vector. */
export function toMemory(row: MemoryRow, embedder: Embedder | null) {
  const { embedding_model, ...rest } = row;
  return { ...rest, indexed: !!embedder && embedding_model === embedder.model };
}
export type Memory = ReturnType<typeof toMemory>;

export type MemoryChanges = {
  added: Memory[];
  updated: { previous_id: string; memory: Memory }[];
  forgotten: string[];
};

type UsageKind = 'memory' | 'embedding';
type Usage = {
  conversation_id?: string | null;
  provider: ProviderId;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated: boolean;
  kind: UsageKind | 'summary';
};

/** Appends to the quota ledger; a failure is logged, never fatal. */
export async function recordUsage(db: SupabaseClient, log: Logger, usage: Usage) {
  const { error } = await db.from('ai_usage').insert(usage);
  if (error) log.error(error, 'failed to record ai usage');
}

type Logger = Pick<FastifyBaseLogger, 'error' | 'warn'>;

export type MemoryServiceOptions = {
  gateway: Gateway | null;
  embedder: Embedder | null;
  maxDistance: number;
  recallCount: number;
  log: Logger;
  embedTimeoutMs?: number;
  extractTimeoutMs?: number;
};

const vectorLiteral = (v: number[]) => `[${v.join(',')}]`;

export function createMemoryService(opts: MemoryServiceOptions) {
  const { gateway, embedder, log } = opts;
  const embedTimeoutMs = opts.embedTimeoutMs ?? 10_000;
  const extractTimeoutMs = opts.extractTimeoutMs ?? 30_000;

  /** Embeds and charges the quota (estimated when the vendor reports nothing). */
  async function embed(
    db: SupabaseClient,
    texts: string[],
    kind: EmbedKind,
    conversationId?: string | null,
  ): Promise<number[][] | null> {
    if (!embedder || !texts.length) return null;
    try {
      const { vectors, inputTokens } = await embedder.embed(
        texts,
        kind,
        AbortSignal.timeout(embedTimeoutMs),
      );
      await recordUsage(db, log, {
        conversation_id: conversationId ?? null,
        provider: embedder.provider,
        model: embedder.model,
        input_tokens: inputTokens ?? Math.ceil(texts.join('').length / 4),
        output_tokens: 0,
        estimated: inputTokens === null,
        kind: 'embedding',
      });
      return vectors;
    } catch (err) {
      // Degrade to lexical recall rather than failing the user's request.
      log.warn({ err: (err as Error).message }, 'embedding failed');
      return null;
    }
  }

  /** Hybrid recall (lexical + semantic when an embedder is configured). */
  async function recall(
    db: SupabaseClient,
    query: string,
    count = opts.recallCount,
    conversationId?: string | null,
  ): Promise<(RecalledMemory & { score: number })[]> {
    const vector = (await embed(db, [query.slice(0, 2000)], 'query', conversationId))?.[0];
    const { data, error } = await db.rpc('match_memories', {
      query_text: query.slice(0, 2000),
      query_embedding: vector ? vectorLiteral(vector) : null,
      embedding_model: vector ? embedder!.model : null,
      match_count: count,
      max_distance: opts.maxDistance,
    });
    if (error) throw error;
    return data;
  }

  async function insert(
    db: SupabaseClient,
    rows: {
      workspace_id: string;
      kind: MemoryKind;
      content: string;
      importance: number;
      source: 'manual' | 'conversation';
      source_message_id?: string | null;
    }[],
    conversationId?: string | null,
  ): Promise<MemoryRow[]> {
    if (!rows.length) return [];
    const vectors = await embed(
      db,
      rows.map((r) => r.content),
      'document',
      conversationId,
    );
    const { data, error } = await db
      .from('memories')
      .insert(
        rows.map((r, i) => ({
          ...r,
          ...(vectors && {
            embedding: vectorLiteral(vectors[i]!),
            embedding_model: embedder!.model,
          }),
        })),
      )
      .select(MEMORY_COLUMNS);
    if (error) throw error;
    return data as MemoryRow[];
  }

  /** Re-embeds one memory after its text changed (the database cleared the stale vector). */
  async function reembed(db: SupabaseClient, row: MemoryRow): Promise<MemoryRow> {
    const vectors = await embed(db, [row.content], 'document');
    if (!vectors) return row;
    const { data, error } = await db
      .from('memories')
      .update({ embedding: vectorLiteral(vectors[0]!), embedding_model: embedder!.model })
      .eq('id', row.id)
      .eq('content', row.content) // a concurrent edit wins
      .select(MEMORY_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    return (data as MemoryRow | null) ?? row;
  }

  /** Embeds active memories without a vector of the current model (model change, outage). */
  async function reindex(db: SupabaseClient, batch = 50) {
    if (!embedder) return { indexed: 0, remaining: 0 };
    const pending = await db
      .from('memories')
      .select('id, content', { count: 'exact' })
      .eq('status', 'active')
      .or(`embedding_model.is.null,embedding_model.neq.${JSON.stringify(embedder.model)}`)
      .limit(batch);
    if (pending.error) throw pending.error;
    const rows = pending.data;
    const vectors = await embed(
      db,
      rows.map((r) => r.content),
      'document',
    );
    let indexed = 0;
    if (vectors) {
      for (const [i, row] of rows.entries()) {
        const { error } = await db
          .from('memories')
          .update({ embedding: vectorLiteral(vectors[i]!), embedding_model: embedder.model })
          .eq('id', row.id)
          .eq('content', row.content);
        if (error) throw error;
        indexed++;
      }
    }
    return { indexed, remaining: Math.max((pending.count ?? 0) - indexed, 0) };
  }

  /**
   * Asks the model which durable facts the user's message adds, updates (contradicts)
   * or retracts, given the memories already recalled for it. One call, bounded in time.
   */
  async function extract(
    db: SupabaseClient,
    input: {
      choice: AiChoice;
      message: string;
      previousAnswer: string | null;
      known: RecalledMemory[];
      conversationId: string;
    },
  ): Promise<MemoryOperation[]> {
    if (!gateway) return [];
    const { text, usage } = await gateway.complete({
      ...input.choice,
      system: EXTRACTION_SYSTEM,
      history: [
        {
          role: 'user',
          content: extractionInput(input.message, input.known, input.previousAnswer),
        },
      ],
      maxOutputTokens: 1024,
      signal: AbortSignal.timeout(extractTimeoutMs),
    });
    await recordUsage(db, log, {
      conversation_id: input.conversationId,
      provider: input.choice.provider,
      model: input.choice.model,
      input_tokens:
        usage?.inputTokens ??
        Math.ceil((EXTRACTION_SYSTEM.length + input.message.length + 2000) / 4),
      output_tokens: usage?.outputTokens ?? Math.ceil(text.length / 4),
      estimated: !usage,
      kind: 'memory',
    });
    return parseOperations(text, input.known);
  }

  /**
   * Applies operations: "update" stores the new text as a new memory and marks the old one
   * superseded by it (history kept, restorable); "forget" archives without replacement.
   */
  async function apply(
    db: SupabaseClient,
    ops: MemoryOperation[],
    ctx: { workspaceId: string; sourceMessageId: string; conversationId: string },
  ): Promise<MemoryChanges> {
    const changes: MemoryChanges = { added: [], updated: [], forgotten: [] };
    const writes = ops.filter((o) => o.op !== 'forget');
    const inserted = await insert(
      db,
      writes.map((o) => ({
        workspace_id: ctx.workspaceId,
        kind: o.kind,
        content: o.content,
        importance: o.importance,
        source: 'conversation' as const,
        source_message_id: ctx.sourceMessageId,
      })),
      ctx.conversationId,
    );
    for (const [i, op] of writes.entries()) {
      const row = inserted[i]!;
      if (op.op === 'add') {
        changes.added.push(toMemory(row, embedder));
        continue;
      }
      const { error } = await db
        .from('memories')
        .update({ status: 'superseded', superseded_by: row.id })
        .eq('id', op.id)
        .eq('status', 'active');
      if (error) log.error(error, 'failed to supersede memory');
      changes.updated.push({ previous_id: op.id, memory: toMemory(row, embedder) });
    }
    const forget = ops.flatMap((o) => (o.op === 'forget' ? [o.id] : []));
    if (forget.length) {
      const { data, error } = await db
        .from('memories')
        .update({ status: 'superseded' })
        .in('id', forget)
        .eq('status', 'active')
        .select('id');
      if (error) throw error;
      changes.forgotten = data.map((r) => r.id);
    }
    return changes;
  }

  return { embedder, embed, recall, insert, reembed, reindex, extract, apply };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
