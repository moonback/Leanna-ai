import { AiError, aiErrorFromStatus, type AiProvider, type StreamEvent } from './types.js';
import { toAiError } from './gemini.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

type Chunk = {
  error?: { code?: number; message?: string };
  choices?: {
    delta?: { content?: string | null };
    finish_reason?: string | null;
    error?: { code?: number };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Mid-stream errors carry an HTTP-like code in the payload instead of the status line. */
function errorFromChunk(code: number | undefined): AiError {
  return typeof code === 'number'
    ? aiErrorFromStatus(code)
    : new AiError('unavailable', 'Stream error', true);
}

/**
 * OpenRouter (OpenAI-compatible chat completions, streamed). Plain fetch, no SDK.
 * Usage arrives once, in the final chunk before `[DONE]`; completion_tokens includes
 * reasoning tokens, so the quota counts them.
 */
export function openRouterProvider(apiKey: string, fetchImpl: typeof fetch = fetch): AiProvider {
  return {
    name: 'openrouter',
    async *stream(req) {
      try {
        const res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'x-title': 'LEANA AI',
          },
          body: JSON.stringify({
            model: req.model,
            stream: true,
            max_tokens: req.maxOutputTokens,
            messages: [{ role: 'system', content: req.system }, ...req.history],
          }),
          signal: req.signal,
        });
        if (!res.ok || !res.body) throw aiErrorFromStatus(res.status);

        let usage: Extract<StreamEvent, { type: 'usage' }> | null = null;
        let buffer = '';
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            // Blank lines separate events; ": OPENROUTER PROCESSING" is a keep-alive comment.
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            const chunk = JSON.parse(payload) as Chunk;
            if (chunk.error) throw errorFromChunk(chunk.error.code);
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason === 'error') throw errorFromChunk(choice.error?.code);
            const text = choice?.delta?.content;
            if (text) yield { type: 'text', text };
            if (chunk.usage) {
              usage = {
                type: 'usage',
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              };
            }
          }
        }
        // No usage reported: say nothing rather than "0", the caller then records an estimate.
        if (usage) yield usage;
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}
