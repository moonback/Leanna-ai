import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';
import { requireAuth } from '../plugins/auth.js';
import type { Gateway } from '../ai/gateway.js';
import { describeAi, type AiCatalog } from '../ai/catalog.js';
import { AiError } from '../ai/types.js';
import type { Background } from '../background.js';
import {
  buildContext,
  CONTEXT_BUDGET,
  SUMMARY_SYSTEM,
  summaryInput,
  type StoredMessage,
} from '../context/engine.js';
import {
  MIN_EXTRACTION_CHARS,
  type MemoryOperation,
  type RecalledMemory,
} from '../memory/extract.js';
import { recordUsage, type MemoryChanges, type MemoryService } from '../memory/service.js';
import { defaultWorkspaceId, memoryEnabled } from './workspace.js';

export type ConversationOptions = {
  gateway: Gateway | null;
  catalog: AiCatalog;
  memory: MemoryService;
  background: Background;
  maxOutputTokens: number;
  dailyTokenLimit: number;
};

const IdParams = z.object({ id: z.uuid() });
const TitleBody = z.object({ title: z.string().trim().min(1).max(120) }).strict();
const CreateBody = z.object({ title: z.string().trim().min(1).max(120).optional() }).strict();
const MessageBody = z.object({ content: z.string().trim().min(1).max(8000) }).strict();

const CONVERSATION_COLUMNS = 'id, title, created_at, updated_at';
const MESSAGE_COLUMNS = 'id, role, content, status, provider, model, error_code, created_at';

/** How long the reply stream waits for memory extraction after the answer is done. */
const MEMORY_WAIT_MS = 20_000;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

export async function conversationRoutes(app: FastifyInstance, opts: ConversationOptions) {
  const { gateway } = opts;
  app.addHook('preHandler', app.authenticate);
  const docs = (summary: string) => ({ tags: ['assistant'], summary, security: [{ bearer: [] }] });

  app.get(
    '/ai/config',
    { schema: docs('AI providers, their availability and allowed models') },
    async () => describeAi(opts.catalog, gateway, opts.memory.embedder),
  );

  app.get(
    '/conversations',
    { schema: docs('List my conversations, most recent first') },
    async (req) => {
      const { db } = requireAuth(req);
      const { data, error } = await db
        .from('conversations')
        .select(CONVERSATION_COLUMNS)
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  );

  app.post('/conversations', { schema: docs('Start a conversation') }, async (req, reply) => {
    const { db, userId } = requireAuth(req);
    const body = parse(CreateBody, req.body);

    const workspaceId = await defaultWorkspaceId(db, userId);

    const { data, error } = await db
      .from('conversations')
      .insert({ workspace_id: workspaceId, title: body.title ?? null })
      .select(CONVERSATION_COLUMNS)
      .single();
    if (error) throw error;
    return reply.status(201).send(data);
  });

  app.patch('/conversations/:id', { schema: docs('Rename a conversation') }, async (req) => {
    const { db } = requireAuth(req);
    const { id } = parse(IdParams, req.params);
    const { title } = parse(TitleBody, req.body);
    const { data, error } = await db
      .from('conversations')
      .update({ title })
      .eq('id', id)
      .select(CONVERSATION_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw httpError(404, 'Conversation not found');
    return data;
  });

  app.delete(
    '/conversations/:id',
    { schema: docs('Delete a conversation and its messages') },
    async (req, reply) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const { data, error } = await db.from('conversations').delete().eq('id', id).select('id');
      if (error) throw error;
      if (!data.length) throw httpError(404, 'Conversation not found');
      return reply.status(204).send();
    },
  );

  app.get(
    '/conversations/:id/messages',
    { schema: docs('Messages of a conversation') },
    async (req) => {
      const { db } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const conv = await db.from('conversations').select('id').eq('id', id).maybeSingle();
      if (conv.error) throw conv.error;
      if (!conv.data) throw httpError(404, 'Conversation not found');

      const { data, error } = await db
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .eq('conversation_id', id)
        .order('created_at');
      if (error) throw error;
      return data;
    },
  );

  app.post(
    '/conversations/:id/messages',
    { schema: docs('Send a message; the reply streams back as Server-Sent Events') },
    async (req, reply) => {
      const { db, userId } = requireAuth(req);
      const { id } = parse(IdParams, req.params);
      const { content } = parse(MessageBody, req.body);

      const conv = await db
        .from('conversations')
        .select('id, title, workspace_id, summary, summary_until')
        .eq('id', id)
        .maybeSingle();
      if (conv.error) throw conv.error;
      if (!conv.data) throw httpError(404, 'Conversation not found');
      if (!gateway) throw httpError(503, 'AI not configured');
      const { summary, summary_until: summaryUntil, workspace_id: workspaceId } = conv.data;

      const since = new Date(Date.now() - 86_400_000).toISOString();
      let previousQuery = db
        .from('messages')
        .select('role, content, status, created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: false })
        .limit(CONTEXT_BUDGET.maxMessages);
      if (summaryUntil) previousQuery = previousQuery.gt('created_at', summaryUntil);
      const [profile, prefs, used, previous] = await Promise.all([
        db.from('profiles').select('display_name, locale, timezone').eq('id', userId).single(),
        db.from('preferences').select('settings').eq('user_id', userId).single(),
        db.rpc('ai_tokens_used_since', { since }),
        previousQuery,
      ]);
      for (const r of [profile, prefs, used, previous]) if (r.error) throw r.error;
      if (Number(used.data) >= opts.dailyTokenLimit) throw httpError(429, 'Daily AI quota reached');

      const choice = gateway.resolve(prefs.data!.settings);
      const { provider, model } = choice;
      const withMemory = memoryEnabled(prefs.data!.settings);
      const earlier = (previous.data as StoredMessage[]).reverse();

      // Recall: never blocks the reply; without memories the model still answers.
      let recalled: RecalledMemory[] = [];
      if (withMemory) {
        try {
          recalled = await opts.memory.recall(db, content, undefined, id);
        } catch (err) {
          req.log.error(err, 'memory recall failed');
        }
      }

      const context = buildContext({
        profile: profile.data!,
        memoryEnabled: withMemory,
        memories: recalled,
        summary,
        messages: [...earlier, { role: 'user', content, status: 'complete' }],
      });
      const { system, history } = context;
      const promptChars = system.length + history.reduce((n, t) => n + t.content.length, 0);

      const userMessage = await db
        .from('messages')
        .insert({ conversation_id: id, role: 'user', content })
        .select('id, created_at')
        .single();
      if (userMessage.error) throw userMessage.error;
      if (!conv.data.title) {
        await db
          .from('conversations')
          .update({ title: content.slice(0, 60) })
          .eq('id', id);
      }

      // Extraction runs alongside the reply (one extra model call, not after it).
      const lastAnswer = earlier.findLast((m) => m.role === 'assistant' && m.status === 'complete');
      const extraction: Promise<MemoryOperation[]> | null =
        withMemory && content.length >= MIN_EXTRACTION_CHARS
          ? opts.memory
              .extract(db, {
                choice,
                message: content,
                previousAnswer: lastAnswer?.content ?? null,
                known: recalled,
                conversationId: id,
              })
              .catch((err: unknown) => {
                req.log.warn({ err: (err as Error).message }, 'memory extraction failed');
                return [];
              })
          : null;
      const applyMemory = async (): Promise<MemoryChanges | null> => {
        if (!extraction) return null;
        let timer: NodeJS.Timeout | undefined;
        const ops = await Promise.race([
          extraction,
          new Promise<MemoryOperation[]>((resolve) => {
            timer = setTimeout(() => resolve([]), MEMORY_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (!ops.length) return null;
        try {
          return await opts.memory.apply(db, ops, {
            workspaceId,
            sourceMessageId: userMessage.data.id,
            conversationId: id,
          });
        } catch (err) {
          req.log.error(err, 'failed to store memories');
          return null;
        }
      };

      // Folding older turns into the summary happens after the response has ended.
      const summarize = () => {
        const plan = context.toSummarize;
        if (!plan) return;
        opts.background.run('conversation summary', async () => {
          const { text, usage } = await gateway.complete({
            ...choice,
            system: SUMMARY_SYSTEM,
            history: [{ role: 'user', content: summaryInput(summary, plan.turns) }],
            maxOutputTokens: 1024,
          });
          const chars = SUMMARY_SYSTEM.length + summaryInput(summary, plan.turns).length;
          await recordUsage(db, req.log, {
            conversation_id: id,
            provider,
            model,
            input_tokens: usage?.inputTokens ?? Math.ceil(chars / 4),
            output_tokens: usage?.outputTokens ?? Math.ceil(text.length / 4),
            estimated: !usage,
            kind: 'summary',
          });
          if (!text.trim()) return;
          // Guarded on the previous value: a concurrent summary of the same turns loses.
          let update = db
            .from('conversations')
            .update({ summary: text.trim().slice(0, 8000), summary_until: plan.until })
            .eq('id', id);
          update = summaryUntil
            ? update.eq('summary_until', summaryUntil)
            : update.is('summary_until', null);
          const { error } = await update;
          if (error) throw error;
        });
      };

      // ---- stream. Hijacked replies skip Fastify's serializer, so copy the CORS headers.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...(reply.getHeaders() as OutgoingHttpHeaders),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // disable proxy buffering (Railway/nginx)
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });

      let answer = '';
      // Provider-reported usage when available; otherwise an estimate (~4 chars/token) so
      // a stopped, failed or unreported reply still counts against the daily quota.
      const recordChatUsage = async (
        usage: { inputTokens: number; outputTokens: number } | null,
      ) => {
        const { error } = await db.from('ai_usage').insert({
          conversation_id: id,
          provider,
          model,
          input_tokens: usage?.inputTokens ?? Math.ceil(promptChars / 4),
          output_tokens: usage?.outputTokens ?? Math.ceil(answer.length / 4),
          estimated: !usage,
        });
        if (error) req.log.error(error, 'failed to record ai usage');
      };

      send('start', {
        userMessageId: userMessage.data.id,
        provider,
        model,
        context: { memories: context.stats.memories, summarized: !!summary },
      });
      try {
        let usage: { inputTokens: number; outputTokens: number } | null = null;
        for await (const event of gateway.stream({
          provider,
          model,
          system,
          history,
          maxOutputTokens: opts.maxOutputTokens,
          signal: abort.signal,
        })) {
          if (event.type === 'text') {
            answer += event.text;
            send('delta', { text: event.text });
          } else usage = event;
        }
        if (!answer.trim()) throw new AiError('empty_response', 'The model returned no text');

        const saved = await db
          .from('messages')
          .insert({
            conversation_id: id,
            role: 'assistant',
            content: answer.slice(0, 32000),
            provider,
            model,
          })
          .select(MESSAGE_COLUMNS)
          .single();
        if (saved.error) throw saved.error;
        await recordChatUsage(usage);
        send('done', { message: saved.data, usage });
        summarize();
      } catch (err) {
        const code = err instanceof AiError ? err.code : 'internal';
        if (!(err instanceof AiError)) req.log.error(err);
        // Keep the partial text so the user sees what arrived; excluded from future context.
        const failed = await db.from('messages').insert({
          conversation_id: id,
          role: 'assistant',
          content: answer.slice(0, 32000),
          status: code === 'aborted' ? 'interrupted' : 'error',
          provider,
          model,
          error_code: code,
        });
        if (failed.error) req.log.error(failed.error, 'failed to record failed answer');
        // The provider did work (partial text, stop, timeout): charge an estimate.
        if (answer || code === 'aborted' || code === 'timeout') await recordChatUsage(null);
        if (!res.writableEnded && !abort.signal.aborted) send('error', { code });
      } finally {
        const changes = await applyMemory();
        if (changes && !res.writableEnded && !abort.signal.aborted) send('memory', changes);
        clearInterval(heartbeat);
        res.end();
      }
    },
  );
}
