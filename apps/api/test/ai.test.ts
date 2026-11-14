import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { createGateway } from '../src/ai/gateway.js';
import { geminiProvider, toAiError } from '../src/ai/gemini.js';
import { openRouterProvider } from '../src/ai/openrouter.js';
import { AiError, type AiProvider, type StreamEvent } from '../src/ai/types.js';

const log = { info: vi.fn(), warn: vi.fn() };
const base = {
  provider: 'gemini' as const,
  system: 'sys',
  history: [{ role: 'user' as const, content: 'Bonjour' }],
  maxOutputTokens: 100,
};

function gateway(provider: AiProvider, timeoutMs = 1000) {
  return createGateway({
    providers: { gemini: { provider, models: ['m1', 'm2'], defaultModel: 'm1' } },
    defaultProvider: 'gemini',
    timeoutMs,
    retryDelayMs: 1,
    log,
  });
}

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Provider whose n-th call runs the n-th script. */
function scripted(...scripts: Array<(signal: AbortSignal) => AsyncGenerator<StreamEvent>>) {
  let call = 0;
  const provider: AiProvider & { calls: () => number } = {
    name: 'fake',
    calls: () => call,
    stream: ({ signal }) => scripts[Math.min(call++, scripts.length - 1)]!(signal),
  };
  return provider;
}

describe('gateway', () => {
  it('streams text then usage', async () => {
    const p = scripted(async function* () {
      yield { type: 'text', text: 'Bon' };
      yield { type: 'text', text: 'jour' };
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 };
    });
    expect(await collect(gateway(p).stream({ ...base, model: 'm1' }))).toEqual([
      { type: 'text', text: 'Bon' },
      { type: 'text', text: 'jour' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
  });

  it('retries a transient failure that happens before the first chunk', async () => {
    const p = scripted(
      // eslint-disable-next-line require-yield
      async function* () {
        throw new AiError('rate_limited', '429', true);
      },
      async function* () {
        yield { type: 'text', text: 'ok' };
      },
    );
    const events = await collect(gateway(p).stream({ ...base, model: 'm1' }));
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
    expect(p.calls()).toBe(2);
  });

  it('never retries after text was sent (no duplicated partial answer)', async () => {
    const p = scripted(async function* () {
      yield { type: 'text', text: 'partial' };
      throw new AiError('unavailable', '503', true);
    });
    await expect(collect(gateway(p).stream({ ...base, model: 'm1' }))).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(p.calls()).toBe(1);
  });

  it('does not retry non-transient errors', async () => {
    // eslint-disable-next-line require-yield
    const p = scripted(async function* () {
      throw new AiError('auth', 'bad key');
    });
    await expect(collect(gateway(p).stream({ ...base, model: 'm1' }))).rejects.toMatchObject({
      code: 'auth',
    });
    expect(p.calls()).toBe(1);
  });

  it('times out a stalled provider', async () => {
    const p = scripted(async function* (signal) {
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
      yield { type: 'text', text: 'never' };
    });
    await expect(collect(gateway(p, 1000).stream({ ...base, model: 'm1' }))).rejects.toMatchObject({
      code: 'timeout',
    });
  }, 5000);

  it('reports a client abort as aborted', async () => {
    const ctrl = new AbortController();
    const p = scripted(async function* (signal) {
      yield { type: 'text', text: 'a' };
      ctrl.abort();
      if (signal.aborted) throw new AiError('unavailable', 'stream cut');
    });
    await expect(
      collect(gateway(p).stream({ ...base, model: 'm1', signal: ctrl.signal })),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it("refuses models outside the allowlist, including another provider's models", async () => {
    const g = gateway(scripted(async function* () {}));
    await expect(collect(g.stream({ ...base, model: 'gpt-x' }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      collect(g.stream({ ...base, provider: 'openrouter', model: 'm1' })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('resolves preferences across providers and falls back when one is not configured', () => {
    const noop = scripted(async function* () {});
    const g = createGateway({
      providers: {
        gemini: { provider: noop, models: ['g1', 'g2'], defaultModel: 'g1' },
        openrouter: { provider: noop, models: ['o1', 'o2'], defaultModel: 'o1' },
      },
      defaultProvider: 'gemini',
      timeoutMs: 1000,
      log,
    });
    expect(g.resolve(null)).toEqual({ provider: 'gemini', model: 'g1' });
    expect(g.resolve({ ai_provider: 'openrouter' })).toEqual({
      provider: 'openrouter',
      model: 'o1',
    });
    expect(g.resolve({ ai_provider: 'openrouter', ai_model: 'o2' })).toEqual({
      provider: 'openrouter',
      model: 'o2',
    });
    // A model of another provider, or one removed from the allowlist, falls back.
    expect(g.resolve({ ai_provider: 'openrouter', ai_model: 'g2' })).toEqual({
      provider: 'openrouter',
      model: 'o1',
    });

    const geminiOnly = gateway(noop);
    expect(geminiOnly.resolve({ ai_provider: 'openrouter', ai_model: 'o2' })).toEqual({
      provider: 'gemini',
      model: 'm1',
    });
  });

  it('uses the first configured provider when the default one has no key', () => {
    const g = createGateway({
      providers: {
        openrouter: {
          provider: scripted(async function* () {}),
          models: ['o1'],
          defaultModel: 'o1',
        },
      },
      defaultProvider: 'gemini',
      timeoutMs: 1000,
      log,
    });
    expect(g.defaultChoice).toEqual({ provider: 'openrouter', model: 'o1' });
  });

  it('never logs prompt or reply text', async () => {
    log.info.mockClear();
    const p = scripted(async function* () {
      yield { type: 'text', text: 'SECRET-REPLY' };
    });
    await collect(
      gateway(p).stream({
        ...base,
        model: 'm1',
        history: [{ role: 'user', content: 'SECRET-PROMPT' }],
      }),
    );
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).toContain('"outcome":"ok"');
  });
});

describe('gemini adapter', () => {
  it('maps roles, sends config and counts thinking tokens as output', async () => {
    const generateContentStream = vi.fn(async () =>
      (async function* () {
        yield { text: 'Bon', usageMetadata: undefined };
        yield {
          text: 'jour',
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 4 },
        };
      })(),
    );
    const provider = geminiProvider('k', { models: { generateContentStream } } as never);
    const signal = new AbortController().signal;
    const events = await collect(
      provider.stream({
        model: 'gemini-x',
        system: 'Tu es LEANA',
        maxOutputTokens: 256,
        signal,
        history: [
          { role: 'user', content: 'Salut' },
          { role: 'assistant', content: 'Bonjour !' },
          { role: 'user', content: 'Ça va ?' },
        ],
      }),
    );

    expect(events).toEqual([
      { type: 'text', text: 'Bon' },
      { type: 'text', text: 'jour' },
      { type: 'usage', inputTokens: 10, outputTokens: 7 },
    ]);
    expect(generateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-x',
        contents: [
          { role: 'user', parts: [{ text: 'Salut' }] },
          { role: 'model', parts: [{ text: 'Bonjour !' }] },
          { role: 'user', parts: [{ text: 'Ça va ?' }] },
        ],
        config: expect.objectContaining({
          systemInstruction: 'Tu es LEANA',
          maxOutputTokens: 256,
          abortSignal: signal,
        }),
      }),
    );
  });

  it.each([
    [429, 'rate_limited', true],
    [401, 'auth', false],
    [404, 'model_not_found', false],
    [400, 'invalid_request', false],
    [503, 'unavailable', true],
  ] as const)('maps HTTP %i to %s', (status, code, retryable) => {
    const err = toAiError(new ApiError({ message: 'x', status }));
    expect(err).toMatchObject({ code, retryable });
  });

  it('maps network failures to a retryable error', () => {
    expect(toAiError(new TypeError('fetch failed'))).toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });
});

describe('openrouter adapter', () => {
  /** A fetch double answering with an SSE body split into arbitrary network chunks. */
  function sseFetch(chunks: string[], status = 200) {
    const encoder = new TextEncoder();
    return vi.fn(async () =>
      status !== 200
        ? new Response(JSON.stringify({ error: { code: status, message: 'x' } }), { status })
        : new Response(
            new ReadableStream({
              start(c) {
                chunks.forEach((s) => c.enqueue(encoder.encode(s)));
                c.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
    );
  }
  const req = {
    model: 'anthropic/claude-haiku-5.5',
    system: 'Tu es LEANA',
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    history: [
      { role: 'user' as const, content: 'Salut' },
      { role: 'assistant' as const, content: 'Bonjour !' },
      { role: 'user' as const, content: 'Ça va ?' },
    ],
  };
  const delta = (text: string) =>
    `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`;

  it('streams text, skips keep-alive comments and reads usage from the final chunk', async () => {
    const fetchImpl = sseFetch([
      ': OPENROUTER PROCESSING\n\n',
      delta('Bon').slice(0, 20),
      delta('Bon').slice(20) + delta('jour'),
      'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const events = await collect(openRouterProvider('sk-test', fetchImpl).stream(req));

    expect(events).toEqual([
      { type: 'text', text: 'Bon' },
      { type: 'text', text: 'jour' },
      { type: 'usage', inputTokens: 30, outputTokens: 12 },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'anthropic/claude-haiku-5.5',
      stream: true,
      max_tokens: 256,
      messages: [
        { role: 'system', content: 'Tu es LEANA' },
        { role: 'user', content: 'Salut' },
        { role: 'assistant', content: 'Bonjour !' },
        { role: 'user', content: 'Ça va ?' },
      ],
    });
    expect(init.signal).toBe(req.signal);
  });

  it('turns a mid-stream provider error into a gateway error', async () => {
    const fetchImpl = sseFetch([
      delta('partiel'),
      'data: {"choices":[{"delta":{"content":""},"finish_reason":"error","error":{"code":502,"message":"Provider disconnected"}}]}\n\n',
    ]);
    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of openRouterProvider('k', fetchImpl).stream(req)) seen.push(e);
      })(),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    expect(seen).toEqual([{ type: 'text', text: 'partiel' }]);
  });

  it.each([
    [402, 'payment_required', false],
    [401, 'auth', false],
    [429, 'rate_limited', true],
    [404, 'model_not_found', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    await expect(
      collect(openRouterProvider('k', sseFetch([], status)).stream(req)),
    ).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it('reports no usage rather than zero when the provider omits it', async () => {
    const events = await collect(
      openRouterProvider('k', sseFetch([delta('ok'), 'data: [DONE]\n\n'])).stream(req),
    );
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
