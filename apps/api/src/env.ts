import { z } from 'zod';

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

    // AI gateway. Without a key the assistant answers 503 "not configured" (no simulation).
    // An empty line copied from .env.example means "no key", not an invalid config.
    GEMINI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
    // Server-side allowlist: users may only pick one of these.
    AI_MODELS: z
      .string()
      .default('gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite')
      .transform((s) =>
        s
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
      ),
    // Each listed model was verified with the adapter's exact config (streaming, thinking LOW)
    // on 2026-11-14; gemini-3.8-flash was left out: 503 "high demand" or no answer within 45 s.
    AI_DEFAULT_MODEL: z.string().default('gemini-3.6-flash'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).default(2048),
    // Per-user cap over a rolling 24 h window (input + output + thinking tokens).
    AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(1).default(200_000),
  })
  .refine((e) => e.AI_MODELS.includes(e.AI_DEFAULT_MODEL), {
    message: 'AI_DEFAULT_MODEL must be listed in AI_MODELS',
    path: ['AI_DEFAULT_MODEL'],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
