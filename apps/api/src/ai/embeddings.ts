import { GoogleGenAI } from '@google/genai';
import { toAiError } from './gemini.js';
import { AiError, aiErrorFromStatus, type ProviderId } from './types.js';

/** Must match `vector(768)` in the `memory` migration. */
export const EMBEDDING_DIMENSIONS = 768;

/** 'document' = text being stored, 'query' = text used to search (asymmetric retrieval). */
export type EmbedKind = 'document' | 'query';

export type EmbedResult = {
  vectors: number[][];
  /** Provider-reported tokens, or null when the provider does not report usage. */
  inputTokens: number | null;
};

export interface Embedder {
  readonly provider: ProviderId;
  readonly model: string;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<EmbedResult>;
}

function checked(vectors: (number[] | undefined)[], expected: number): number[][] {
  if (vectors.length !== expected) {
    throw new AiError('invalid_request', 'Embedding count does not match the input');
  }
  return vectors.map((v) => {
    if (!v || v.length !== EMBEDDING_DIMENSIONS || !v.every(Number.isFinite)) {
      throw new AiError('invalid_request', `Expected ${EMBEDDING_DIMENSIONS}-d embeddings`);
    }
    return v;
  });
}

type GeminiEmbedClient = Pick<GoogleGenAI, 'models'>;

export function geminiEmbedder(
  apiKey: string,
  model: string,
  client: GeminiEmbedClient = new GoogleGenAI({ apiKey }),
): Embedder {
  return {
    provider: 'gemini',
    model,
    async embed(texts, kind, signal) {
      try {
        const res = await client.models.embedContent({
          model,
          contents: texts,
          config: {
            taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            outputDimensionality: EMBEDDING_DIMENSIONS,
            abortSignal: signal,
          },
        });
        return {
          vectors: checked(res.embeddings?.map((e) => e.values) ?? [], texts.length),
          inputTokens: null,
        };
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}

/** OpenRouter embeddings (OpenAI-compatible `/embeddings`). */
export function openRouterEmbedder(
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return {
    provider: 'openrouter',
    model,
    async embed(texts, _kind, signal) {
      try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/embeddings', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'x-title': 'LEANA AI',
          },
          body: JSON.stringify({ model, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
          signal,
        });
        if (!res.ok) throw aiErrorFromStatus(res.status);
        const body = (await res.json()) as {
          data?: { index?: number; embedding?: number[] }[];
          usage?: { prompt_tokens?: number };
        };
        const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return {
          vectors: checked(
            data.map((d) => d.embedding),
            texts.length,
          ),
          inputTokens: body.usage?.prompt_tokens ?? null,
        };
      } catch (err) {
        throw toAiError(err);
      }
    },
  };
}
