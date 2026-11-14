import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { AiError, aiErrorFromStatus, type AiProvider } from './types.js';

type GeminiClient = Pick<GoogleGenAI, 'models'>;

/** Maps SDK/network failures to gateway error codes. */
export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof ApiError) return aiErrorFromStatus(err.status);
  // fetch() network failures surface as TypeError.
  if (err instanceof TypeError) return new AiError('unavailable', 'Network error', true);
  return new AiError('unavailable', 'Unexpected provider error');
}

export function geminiProvider(
  apiKey: string,
  client: GeminiClient = new GoogleGenAI({ apiKey }),
): AiProvider {
  return {
    name: 'gemini',
    async *stream(req) {
      try {
        const stream = await client.models.generateContentStream({
          model: req.model,
          contents: req.history.map((turn) => ({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: turn.content }],
          })),
          config: {
            systemInstruction: req.system,
            maxOutputTokens: req.maxOutputTokens,
            // Chat does not need deep reasoning; thinking tokens are billed as output.
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            abortSignal: req.signal,
          },
        });

        let usage: { prompt: number; output: number } | null = null;
        for await (const chunk of stream) {
          const text = chunk.text;
          if (text) yield { type: 'text', text };
          // Cumulative counts: the last chunk carrying usage is authoritative.
          const u = chunk.usageMetadata;
          if (u) {
            usage = {
              prompt: u.promptTokenCount ?? 0,
              output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
            };
          }
        }
        // No usage reported: say nothing rather than "0", the caller then records an estimate.
        if (usage) yield { type: 'usage', inputTokens: usage.prompt, outputTokens: usage.output };
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}
