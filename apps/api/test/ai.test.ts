import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { createGateway } from '../src/ai/gateway.js';
import { geminiProvider, toAiError } from '../src/ai/gemini.js';
import { AiError, type AiProvider, type StreamEvent } from '../src/ai/types.js';

const log = { info: vi.fn(), warn: vi.fn() };
const base = {
  system: 'sys',
  history: [{ role: 'user' as const, content: 'Bonjour' }],
  maxOutputTokens: 100,
};

function gateway(provider: AiProvider, timeoutMs = 1000) {
  return createGateway({
    provider,
    models: ['m1', 'm2'],
    defaultModel: 'm1',
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

  it('refuses models outside the allowlist and resolves preferences against it', async () => {
    const g = gateway(scripted(async function* () {}));
    await expect(collect(g.stream({ ...base, model: 'gpt-x' }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(g.resolveModel('m2')).toBe('m2');
    expect(g.resolveModel('gpt-x')).toBe('m1');
    expect(g.resolveModel(undefined)).toBe('m1');
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
