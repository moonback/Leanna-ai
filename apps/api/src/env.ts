import { z } from 'zod';
import { PROVIDER_IDS } from './ai/types.js';

// An empty line copied from .env.example means "no key", not an invalid config.
const optionalSecret = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);

const modelList = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    );

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().positive().default(3001),
    // Comma-separated list of allowed browser origins.
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    SUPABASE_URL: z.url(),
    // Publishable (public) key: the API acts with the caller's JWT, so RLS always applies.
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1),

    // AI gateway. A provider without a key is shown as "not configured" (no simulation).
    GEMINI_API_KEY: optionalSecret,
    // Server-side allowlist: users may only pick one of these.
    // Each Gemini model was verified with the adapter's exact config (streaming, thinking LOW)
    // on 2026-11-14; gemini-3.8-flash was left out: 503 "high demand" or no answer within 45 s.
    GEMINI_MODELS: modelList('gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite'),
    GEMINI_DEFAULT_MODEL: z.string().default('gemini-3.6-flash'),

    OPENROUTER_API_KEY: optionalSecret,
    OPENROUTER_MODELS: modelList(
      'anthropic/claude-haiku-5.5,mistralai/mistral-small-2603,openai/gpt-5-mini,deepseek/deepseek-v3.2',
    ),
    OPENROUTER_DEFAULT_MODEL: z.string().default('anthropic/claude-haiku-5.5'),

    // Used when the user has no preference (falls back to any configured provider).
    AI_DEFAULT_PROVIDER: z.enum(PROVIDER_IDS).default('gemini'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).default(2048),
    // Per-user cap over a rolling 24 h window (input + output + thinking tokens).
    AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(1).default(200_000),

    // Memory. Embeddings make recall semantic; without them it stays lexical (full-text).
    // 'auto' = Gemini if its key is set, else OpenRouter if its key is set, else none.
    EMBEDDINGS_PROVIDER: z.enum(['auto', 'none', ...PROVIDER_IDS]).default('auto'),
    GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
    OPENROUTER_EMBEDDING_MODEL: z.string().min(1).default('openai/text-embedding-3-small'),
    // Cosine distance above which a memory is not semantically related. Not calibrated
    // against a real embedding model yet (no key during development): tune with real data.
    MEMORY_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.5),
    MEMORY_RECALL_COUNT: z.coerce.number().int().min(1).max(50).default(8),
  })
  .refine((e) => e.GEMINI_MODELS.includes(e.GEMINI_DEFAULT_MODEL), {
    message: 'GEMINI_DEFAULT_MODEL must be listed in GEMINI_MODELS',
    path: ['GEMINI_DEFAULT_MODEL'],
  })
  .refine((e) => e.OPENROUTER_MODELS.includes(e.OPENROUTER_DEFAULT_MODEL), {
    message: 'OPENROUTER_DEFAULT_MODEL must be listed in OPENROUTER_MODELS',
    path: ['OPENROUTER_DEFAULT_MODEL'],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
