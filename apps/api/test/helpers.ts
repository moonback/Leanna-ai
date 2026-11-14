import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Env } from '../src/env.js';

/** Creates a real account on the local Supabase stack and returns its auth header. */
export async function signUp(env: Env, displayName?: string) {
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const email = `it-${randomUUID()}@example.test`;
  const { data, error } = await sb.auth.signUp({
    email,
    password: `Pw-${randomUUID()}`,
    options: { data: { display_name: displayName } },
  });
  if (error || !data.session) throw error ?? new Error('No session: are email confirmations on?');
  return { email, auth: { authorization: `Bearer ${data.session.access_token}` } };
}

export type SseEvent = { event: string; data: unknown };

/** Parses a complete text/event-stream payload (comments and heartbeats ignored). */
export function parseSse(payload: string): SseEvent[] {
  return payload
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l && !l.startsWith(':')))
    .filter((lines) => lines.length)
    .map((lines) => ({
      event: lines.find((l) => l.startsWith('event: '))!.slice(7),
      data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)),
    }));
}
