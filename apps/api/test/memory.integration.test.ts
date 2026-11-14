// Requires the local Supabase stack. The chat model and the embedder are test doubles:
// these tests check recall, extraction, contradictions and summaries end to end through
// the API and the database (RLS, hybrid SQL search), not the vendors themselves.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import type { AiProvider, StreamEvent, StreamRequest } from '../src/ai/types.js';
import { EXTRACTION_SYSTEM } from '../src/memory/extract.js';
import { SUMMARY_SYSTEM } from '../src/context/engine.js';
import { fakeEmbedder, parseSse, signUp } from './helpers.js';

const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  GEMINI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
});

type Memory = {
  id: string;
  kind: string;
  content: string;
  status: string;
  source: string;
  source_message_id: string | null;
  superseded_by: string | null;
  indexed: boolean;
};

/** Chat replies echo; extraction and summary calls answer what each test scripts. */
function scriptedModel() {
  const chat: StreamRequest[] = [];
  const extraction: StreamRequest[] = [];
  const summary: StreamRequest[] = [];
  let operations: (req: StreamRequest) => unknown[] = () => [];
  const provider: AiProvider = {
    name: 'test-double',
    async *stream(req): AsyncGenerator<StreamEvent> {
      if (req.system === EXTRACTION_SYSTEM) {
        extraction.push(req);
        yield { type: 'text', text: JSON.stringify({ operations: operations(req) }) };
        yield { type: 'usage', inputTokens: 30, outputTokens: 10 };
        return;
      }
      if (req.system === SUMMARY_SYSTEM) {
        summary.push(req);
        yield { type: 'text', text: 'Résumé : Alice a envoyé de longs textes.' };
        return;
      }
      chat.push(req);
      yield { type: 'text', text: `Écho : ${req.history.at(-1)!.content.slice(0, 7000)}` };
      yield { type: 'usage', inputTokens: 12, outputTokens: 5 };
    },
  };
  return {
    provider,
    chat,
    extraction,
    summary,
    remember: (fn: (req: StreamRequest) => unknown[]) => (operations = fn),
    reset() {
      chat.length = extraction.length = summary.length = 0;
      operations = () => [];
    },
  };
}

describe('memory (integration)', () => {
  const model = scriptedModel();
  const embeddings = fakeEmbedder();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    app = await buildApp(env, {
      aiProviders: { gemini: model.provider },
      embedder: embeddings.embedder,
    });
    [alice, bob] = await Promise.all([signUp(env, 'Alice'), signUp(env, 'Bob')]);
  });
  beforeEach(() => {
    model.reset();
    embeddings.calls.length = 0;
    embeddings.fail(false);
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    who = alice,
  ) => app.inject({ method, url, headers: who.auth, ...(payload && { payload }) });
  const teach = async (content: string, who = alice, kind = 'fact') =>
    (await call('POST', '/memories', { content, kind }, who)).json() as Memory;
  const list = async (query = '', who = alice) =>
    (await call('GET', `/memories${query}`, undefined, who)).json() as (Memory & {
      score?: number;
    })[];
  const chat = async (content: string, conversationId?: string, who = alice) => {
    const id =
      conversationId ?? (await call('POST', '/conversations', {}, who)).json<{ id: string }>().id;
    const res = await call('POST', `/conversations/${id}/messages`, { content }, who);
    return { id, res, events: parseSse(res.payload) };
  };
  const clear = (who = alice) => call('DELETE', '/memories', { confirm: true }, who);

  it('reports the embeddings model in /ai/config', async () => {
    const res = await call('GET', '/ai/config');
    expect(res.json().embeddings).toEqual({ provider: 'gemini', model: 'test-embedding' });
  });

  it('stores, lists, corrects (re-embedding) and deletes a memory; duplicates are refused', async () => {
    await clear();
    const created = await teach('Préfère le thé au café', alice, 'preference');
    expect(created).toMatchObject({
      kind: 'preference',
      content: 'Préfère le thé au café',
      source: 'manual',
      status: 'active',
      indexed: true,
    });
    expect(embeddings.calls[0]).toEqual({ texts: ['Préfère le thé au café'], kind: 'document' });

    expect(
      (await call('POST', '/memories', { content: '  préfère le THÉ au café ' })).statusCode,
    ).toBe(409);

    const patched = await call('PATCH', `/memories/${created.id}`, { content: 'Préfère le café' });
    expect(patched.json()).toMatchObject({ content: 'Préfère le café', indexed: true });
    expect(embeddings.calls.at(-1)).toEqual({ texts: ['Préfère le café'], kind: 'document' });

    expect((await list()).map((m) => m.content)).toEqual(['Préfère le café']);
    expect((await call('DELETE', `/memories/${created.id}`)).statusCode).toBe(204);
    expect(await list()).toEqual([]);
  });

  it('validates input', async () => {
    expect((await call('POST', '/memories', { content: '' })).statusCode).toBe(400);
    expect((await call('POST', '/memories', { content: 'x'.repeat(501) })).statusCode).toBe(400);
    expect(
      (await call('POST', '/memories', { content: 'x', kind: 'instruction' })).statusCode,
    ).toBe(400);
    expect((await call('PATCH', '/memories/not-a-uuid', { content: 'x' })).statusCode).toBe(400);
    expect((await call('DELETE', '/memories', {})).statusCode).toBe(400);
  });

  it("keeps each user's memories private", async () => {
    await clear();
    const secret = await teach('Travaille chez Acme');
    expect(await list('', bob)).toEqual([]);
    expect(await list('?q=Acme', bob)).toEqual([]);
    expect(
      (await call('PATCH', `/memories/${secret.id}`, { content: 'pirate' }, bob)).statusCode,
    ).toBe(404);
    expect((await call('DELETE', `/memories/${secret.id}`, undefined, bob)).statusCode).toBe(404);
    expect((await clear(bob)).json()).toEqual({ deleted: 0 });
    expect((await list()).map((m) => m.content)).toEqual(['Travaille chez Acme']);
  });

  it('searches with hybrid recall: words, then meaning without shared words', async () => {
    await clear();
    await teach('Adore les pizzas napolitaines', alice, 'preference');
    await teach('Habite à Lyon');
    await teach('Prépare un marathon', alice, 'goal');

    const lexical = await list('?q=pizza');
    expect(lexical[0]!.content).toBe('Adore les pizzas napolitaines');
    // "manger" shares no word with the memory: only the vectors bring it back.
    const semantic = await list('?q=Où manger ce soir ?');
    expect(semantic.map((m) => m.content)).toEqual(['Adore les pizzas napolitaines']);
    expect(semantic[0]!.score).toBeGreaterThan(0);
    expect(embeddings.calls.at(-1)!.kind).toBe('query');
  });

  it('falls back to lexical recall when embeddings fail, and reindexes later', async () => {
    await clear();
    embeddings.fail(true);
    const stored = await teach('Habite à Lyon');
    expect(stored.indexed).toBe(false);
    expect((await list('?q=Lyon')).map((m) => m.content)).toEqual(['Habite à Lyon']);
    expect(await list('?q=ville')).toEqual([]); // no vectors: no semantic match

    embeddings.fail(false);
    expect((await call('POST', '/memories/reindex')).json()).toEqual({ indexed: 1, remaining: 0 });
    expect((await list('?q=ville')).map((m) => m.content)).toEqual(['Habite à Lyon']);
  });

  it('extracts memories from a message, cites it, and recalls them in later chats', async () => {
    await clear();
    model.remember(() => [
      { op: 'add', kind: 'fact', content: 'Travaille chez Acme', importance: 4 },
      { op: 'add', kind: 'goal', content: 'Courir un marathon en avril', importance: 3 },
    ]);
    const first = await chat('Je travaille chez Acme et je veux courir un marathon en avril.');
    expect(first.events.map((e) => e.event)).toEqual(['start', 'delta', 'done', 'memory']);
    const changes = first.events.at(-1)!.data as { added: Memory[] };
    expect(changes.added.map((m) => m.content)).toEqual([
      'Travaille chez Acme',
      'Courir un marathon en avril',
    ]);
    const userMessageId = (first.events[0]!.data as { userMessageId: string }).userMessageId;
    expect(changes.added[0]).toMatchObject({
      source: 'conversation',
      source_message_id: userMessageId,
      indexed: true,
    });
    // The extractor saw the message as quoted data.
    expect(model.extraction[0]!.history[0]!.content).toContain(
      '"""\nJe travaille chez Acme et je veux courir un marathon en avril.\n"""',
    );

    // A new conversation: the relevant memory is in the system prompt, not the others.
    model.remember(() => []);
    const later = await chat('Comment se passe le boulot ?');
    const system = model.chat.at(-1)!.system;
    expect(system).toContain('- (fact) Travaille chez Acme');
    expect(system).not.toContain('marathon');
    expect((later.events[0]!.data as { context: unknown }).context).toEqual({
      memories: 1,
      summarized: false,
    });
    // The extractor is shown the recalled memory so it can detect duplicates/contradictions.
    expect(model.extraction.at(-1)!.history[0]!.content).toMatch(
      /\[[0-9a-f-]{36}\] \(fact\) Travaille chez Acme/,
    );
  });

  it('resolves a contradiction by superseding the old memory, which can be restored', async () => {
    await clear();
    const paris = await teach('Habite à Paris');
    model.remember(() => [
      {
        op: 'update',
        id: paris.id,
        kind: 'fact',
        content: 'Habite à Lyon depuis 2026',
        importance: 4,
      },
      // Ids the model was not shown are ignored (hallucination or injection).
      { op: 'forget', id: '00000000-0000-4000-8000-000000000000' },
    ]);
    const { events } = await chat('Au fait, j’ai déménagé : j’habite à Lyon maintenant.');
    const changes = events.at(-1)!.data as {
      updated: { previous_id: string; memory: Memory }[];
      forgotten: string[];
    };
    expect(changes.updated).toHaveLength(1);
    expect(changes.updated[0]!.previous_id).toBe(paris.id);
    expect(changes.forgotten).toEqual([]);
    const lyon = changes.updated[0]!.memory;

    expect((await list()).map((m) => m.content)).toEqual(['Habite à Lyon depuis 2026']);
    const old = await list('?status=superseded');
    expect(old).toEqual([expect.objectContaining({ id: paris.id, superseded_by: lyon.id })]);

    // Recall never brings back the superseded fact.
    model.remember(() => []);
    await chat('Dans quelle ville est-ce que j’habite ?');
    expect(model.chat.at(-1)!.system).toContain('Habite à Lyon depuis 2026');
    expect(model.chat.at(-1)!.system).not.toContain('Habite à Paris');

    const restored = await call('POST', `/memories/${paris.id}/restore`);
    expect(restored.json()).toMatchObject({ status: 'active', superseded_by: null });
  });

  it('forgets on request by archiving, not deleting', async () => {
    await clear();
    const jazz = await teach('Aime le jazz', alice, 'preference');
    model.remember(() => [{ op: 'forget', id: jazz.id }]);
    const { events } = await chat('Oublie que j’aime le jazz, ce n’est plus vrai.');
    expect((events.at(-1)!.data as { forgotten: string[] }).forgotten).toEqual([jazz.id]);
    expect(await list()).toEqual([]);
    expect((await list('?status=superseded')).map((m) => m.id)).toEqual([jazz.id]);
  });

  it('does nothing with memory when the user turned it off', async () => {
    await clear();
    await teach('Travaille chez Acme');
    expect((await call('PATCH', '/me/preferences', { memory_enabled: false })).statusCode).toBe(
      200,
    );
    try {
      model.remember(() => [{ op: 'add', kind: 'fact', content: 'Ne doit pas être retenu' }]);
      const { events } = await chat('Je travaille toujours chez Acme, tu te souviens ?');
      expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'done']);
      expect(model.extraction).toHaveLength(0);
      expect(model.chat.at(-1)!.system).not.toContain('Travaille chez Acme');
      expect(model.chat.at(-1)!.system).toContain('Mémoire : désactivée');
    } finally {
      await call('PATCH', '/me/preferences', { memory_enabled: true });
    }
  });

  it('skips extraction for very short messages', async () => {
    await chat('Merci !');
    expect(model.chat).toHaveLength(1);
    expect(model.extraction).toHaveLength(0);
  });

  it('folds older turns into a rolling summary once the conversation is long', async () => {
    const long = (n: number) => `Texte ${n} `.padEnd(7000, 'x');
    let id: string | undefined;
    for (let i = 1; i <= 2; i++) id = (await chat(long(i), id)).id;
    await app.background.settle();
    expect(model.summary).toHaveLength(0); // ~21 k chars of history: under the soft budget

    id = (await chat(long(3), id)).id; // past the soft budget: summary planned
    await app.background.settle();
    expect(model.summary).toHaveLength(1);
    expect(model.summary[0]!.history[0]!.content).toContain('Texte 1');

    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false },
      global: { headers: alice.auth },
    });
    const conv = await sb
      .from('conversations')
      .select('summary, summary_until')
      .eq('id', id!)
      .single();
    expect(conv.data!.summary).toBe('Résumé : Alice a envoyé de longs textes.');

    await chat('Et maintenant ?', id);
    const last = model.chat.at(-1)!;
    expect(last.system).toContain('Résumé des échanges plus anciens de cette conversation :');
    expect(last.history.map((t) => t.content).join('\n')).not.toContain('Texte 1');
    expect(last.history.at(-1)).toEqual({ role: 'user', content: 'Et maintenant ?' });

    // Background calls are charged to the quota, labelled by kind.
    const usage = await sb.from('ai_usage').select('kind').eq('conversation_id', id!);
    expect(new Set(usage.data!.map((u) => u.kind))).toEqual(
      new Set(['chat', 'memory', 'summary', 'embedding']),
    );
  });
});
