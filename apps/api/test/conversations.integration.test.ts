// Requires the local Supabase stack. The AI provider is a test double injected into
// buildApp: these tests check our streaming/persistence logic, not Gemini itself.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { AiError, type AiProvider, type StreamEvent, type StreamRequest } from '../src/ai/types.js';
import { EXTRACTION_SYSTEM } from '../src/memory/extract.js';
import { parseSse, signUp } from './helpers.js';

// Never reach the real provider from these tests, even if a key is in .env.
const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  GEMINI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
});

type Behaviour = (req: StreamRequest) => AsyncGenerator<StreamEvent>;

const defaultEcho: Behaviour = async function* (req) {
  yield { type: 'text', text: 'Écho : ' };
  yield { type: 'text', text: req.history.at(-1)!.content };
  yield { type: 'usage', inputTokens: 12, outputTokens: 5 };
};

function fakeProvider() {
  const calls: StreamRequest[] = [];
  let behaviour = defaultEcho;
  // Memory extraction calls are answered separately (nothing to remember) and not recorded:
  // these tests are about chat replies; memory.integration.test.ts covers extraction.
  const provider: AiProvider = {
    name: 'test-double',
    stream: (req) => {
      if (req.system === EXTRACTION_SYSTEM) {
        return (async function* () {
          yield { type: 'text' as const, text: '{"operations":[]}' };
        })();
      }
      calls.push(req);
      return behaviour(req);
    },
  };
  return {
    provider,
    calls,
    set: (b: Behaviour) => (behaviour = b),
    reset: () => {
      calls.length = 0;
      behaviour = defaultEcho;
    },
  };
}

describe('assistant (integration)', () => {
  const fake = fakeProvider();
  const orFake = fakeProvider();
  beforeEach(() => {
    fake.reset();
    orFake.reset();
  });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;

  const create = async (who = alice) =>
    (
      await app.inject({ method: 'POST', url: '/conversations', headers: who.auth, payload: {} })
    ).json();
  const send = (id: string, content: string, who = alice) =>
    app.inject({
      method: 'POST',
      url: `/conversations/${id}/messages`,
      headers: who.auth,
      payload: { content },
    });
  const messages = async (id: string, who = alice) =>
    (
      await app.inject({ method: 'GET', url: `/conversations/${id}/messages`, headers: who.auth })
    ).json();

  beforeAll(async () => {
    app = await buildApp(env, {
      aiProviders: { gemini: fake.provider, openrouter: orFake.provider },
    });
    [alice, bob] = await Promise.all([signUp(env, 'Alice'), signUp(env, 'Bob')]);
  });

  it('describes both providers with their allowed models, never their keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/ai/config', headers: alice.auth });
    expect(res.json()).toEqual({
      configured: true,
      default: { provider: 'gemini', model: env.GEMINI_DEFAULT_MODEL },
      embeddings: null,
      providers: [
        {
          id: 'gemini',
          label: 'Google Gemini',
          configured: true,
          models: env.GEMINI_MODELS,
          default_model: env.GEMINI_DEFAULT_MODEL,
        },
        {
          id: 'openrouter',
          label: 'OpenRouter',
          configured: true,
          models: env.OPENROUTER_MODELS,
          default_model: env.OPENROUTER_DEFAULT_MODEL,
        },
      ],
    });
  });

  it('streams a reply over SSE and persists both turns', async () => {
    const conv = await create();
    const res = await send(conv.id, 'Bonjour LEANA');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(res.payload);
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(events[3]!.data).toMatchObject({
      message: { role: 'assistant', content: 'Écho : Bonjour LEANA', status: 'complete' },
      usage: { inputTokens: 12, outputTokens: 5 },
    });

    const stored = await messages(conv.id);
    expect(stored.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ['user', 'Bonjour LEANA'],
      ['assistant', 'Écho : Bonjour LEANA'],
    ]);
    const list = await app.inject({ method: 'GET', url: '/conversations', headers: alice.auth });
    expect(list.json()[0]).toMatchObject({ id: conv.id, title: 'Bonjour LEANA' });
  });

  it('sends the conversation history and a personalised system prompt', async () => {
    const conv = await create();
    await send(conv.id, 'Premier');
    fake.reset();
    await send(conv.id, 'Second');

    const req = fake.calls[0]!;
    expect(req.model).toBe(env.GEMINI_DEFAULT_MODEL);
    expect(req.system).toContain('LEANA');
    expect(req.system).toContain('Alice');
    expect(req.history).toEqual([
      { role: 'user', content: 'Premier' },
      { role: 'assistant', content: 'Écho : Premier' },
      { role: 'user', content: 'Second' },
    ]);
  });

  it('keeps a failed answer visible but out of the next context', async () => {
    const conv = await create();
    fake.set(async function* () {
      yield { type: 'text', text: 'Début de répo' };
      throw new AiError('unavailable', 'provider down');
    });
    const failed = parseSse((await send(conv.id, 'Question 1')).payload);
    expect(failed.at(-1)).toEqual({ event: 'error', data: { code: 'unavailable' } });

    const stored = await messages(conv.id);
    expect(stored[1]).toMatchObject({
      role: 'assistant',
      content: 'Début de répo',
      status: 'error',
      error_code: 'unavailable',
    });

    fake.reset();
    await send(conv.id, 'Question 2');
    // No failed assistant turn and no two user turns in a row.
    expect(fake.calls[0]!.history).toEqual([{ role: 'user', content: 'Question 2' }]);
  });

  it('routes to the provider and model chosen in preferences, and records them', async () => {
    const chosen = env.OPENROUTER_MODELS.at(-1)!;
    const pref = await app.inject({
      method: 'PATCH',
      url: '/me/preferences',
      headers: bob.auth,
      payload: { ai_provider: 'openrouter', ai_model: chosen },
    });
    expect(pref.statusCode).toBe(200);

    const conv = await create(bob);
    const events = parseSse((await send(conv.id, 'Salut', bob)).payload);
    expect(events[0]!.data).toMatchObject({ provider: 'openrouter', model: chosen });
    expect(fake.calls).toHaveLength(0);
    expect(orFake.calls[0]!.model).toBe(chosen);

    const stored = await messages(conv.id, bob);
    expect(stored[1]).toMatchObject({ role: 'assistant', provider: 'openrouter', model: chosen });

    // Back to defaults.
    await app.inject({
      method: 'PATCH',
      url: '/me/preferences',
      headers: bob.auth,
      payload: { ai_provider: null, ai_model: null },
    });
    orFake.reset();
    await send(conv.id, 'Encore', bob);
    expect(fake.calls[0]!.model).toBe(env.GEMINI_DEFAULT_MODEL);
    expect(orFake.calls).toHaveLength(0);
  });

  it('isolates conversations between users', async () => {
    const conv = await create(alice);
    for (const res of [
      await app.inject({
        method: 'GET',
        url: `/conversations/${conv.id}/messages`,
        headers: bob.auth,
      }),
      await send(conv.id, 'intrusion', bob),
      await app.inject({ method: 'DELETE', url: `/conversations/${conv.id}`, headers: bob.auth }),
      await app.inject({
        method: 'PATCH',
        url: `/conversations/${conv.id}`,
        headers: bob.auth,
        payload: { title: 'pirate' },
      }),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    const bobs = await app.inject({ method: 'GET', url: '/conversations', headers: bob.auth });
    expect(bobs.json().map((c: { id: string }) => c.id)).not.toContain(conv.id);
  });

  it.each([
    ['empty content', { content: '   ' }],
    ['too long', { content: 'x'.repeat(8001) }],
    ['unknown field', { content: 'ok', role: 'assistant' }],
  ])('rejects invalid messages: %s', async (_, payload) => {
    const conv = await create();
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conv.id}/messages`,
      headers: alice.auth,
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed conversation id', async () => {
    const res = await send('not-a-uuid', 'Bonjour');
    expect(res.statusCode).toBe(400);
  });

  it('renames and deletes a conversation', async () => {
    const conv = await create();
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conv.id}`,
      headers: alice.auth,
      payload: { title: 'Projet vacances' },
    });
    expect(renamed.json().title).toBe('Projet vacances');
    const del = await app.inject({
      method: 'DELETE',
      url: `/conversations/${conv.id}`,
      headers: alice.auth,
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/conversations/${conv.id}/messages`,
      headers: alice.auth,
    });
    expect(after.statusCode).toBe(404);
  });
});

describe('assistant limits (integration)', () => {
  it('answers 503 when no AI key is configured (no simulated replies)', async () => {
    const app = await buildApp(env);
    const user = await signUp(env);
    const config = await app.inject({ method: 'GET', url: '/ai/config', headers: user.auth });
    expect(config.json()).toMatchObject({ configured: false });

    const conv = (
      await app.inject({ method: 'POST', url: '/conversations', headers: user.auth, payload: {} })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conv.id}/messages`,
      headers: user.auth,
      payload: { content: 'Bonjour' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'AI not configured' });
  });

  it('enforces the daily token quota from the usage ledger', async () => {
    const tight = loadEnv({ ...process.env, NODE_ENV: 'test', AI_DAILY_TOKEN_LIMIT: '10' });
    const app = await buildApp(tight, {
      aiProviders: { gemini: { name: 'test-double', stream: defaultEcho } },
    });
    const user = await signUp(tight);
    const conv = (
      await app.inject({ method: 'POST', url: '/conversations', headers: user.auth, payload: {} })
    ).json();
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/conversations/${conv.id}/messages`,
        headers: user.auth,
        payload: { content: 'Bonjour' },
      });

    expect((await send()).statusCode).toBe(200); // 17 tokens recorded
    const blocked = await send();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'Daily AI quota reached' });
  });

  it('charges an estimate when a reply fails mid-way, so "Stop" cannot dodge the quota', async () => {
    const tight = loadEnv({ ...process.env, NODE_ENV: 'test', AI_DAILY_TOKEN_LIMIT: '10' });
    const app = await buildApp(tight, {
      aiProviders: {
        gemini: {
          name: 'test-double',
          // Partial text, then failure: the provider never reports usage.
          stream: async function* () {
            yield { type: 'text', text: 'Une longue réponse commencée' };
            throw new AiError('unavailable', 'cut');
          },
        },
      },
    });
    const user = await signUp(tight);
    const conv = (
      await app.inject({ method: 'POST', url: '/conversations', headers: user.auth, payload: {} })
    ).json();
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/conversations/${conv.id}/messages`,
        headers: user.auth,
        payload: { content: 'Bonjour' },
      });

    const first = parseSse((await send()).payload);
    expect(first.at(-1)).toEqual({ event: 'error', data: { code: 'unavailable' } });
    expect((await send()).statusCode).toBe(429);
  });
});
