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

/**
 * Deterministic test embedder: each word maps to a concept (synonyms share one), and
 * the vector is the normalized bag of concepts. "manger" and "pizza" are therefore close
 * although they share no word, which lets tests tell semantic recall from lexical recall.
 */
const CONCEPTS: Record<string, string> = {
  pizza: 'food',
  pizzas: 'food',
  manger: 'food',
  diner: 'food',
  restaurant: 'food',
  paris: 'city',
  lyon: 'city',
  habite: 'city',
  ville: 'city',
  vis: 'city',
  courir: 'sport',
  marathon: 'sport',
  sport: 'sport',
  acme: 'work',
  travaille: 'work',
  boulot: 'work',
};
const conceptIndex = new Map([...new Set(Object.values(CONCEPTS))].map((c, i) => [c, i]));

export function conceptVector(text: string): number[] {
  const v = new Array<number>(768).fill(0);
  v[767] = 0.05; // never a zero vector (cosine distance would be undefined)
  for (const word of text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/\W+/)) {
    const concept = CONCEPTS[word];
    if (concept) v[conceptIndex.get(concept)!] = 1;
  }
  return v;
}

export function fakeEmbedder(model = 'test-embedding') {
  const calls: { texts: string[]; kind: string }[] = [];
  let failing = false;
  return {
    calls,
    fail: (on: boolean) => (failing = on),
    embedder: {
      provider: 'gemini' as const,
      model,
      async embed(texts: string[], kind: 'document' | 'query') {
        calls.push({ texts, kind });
        if (failing) throw new Error('embedding outage');
        return { vectors: texts.map(conceptVector), inputTokens: null };
      },
    },
  };
}
