// Requires the local Supabase stack (`supabase start`) and apps/api/.env.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const env = loadEnv({ ...process.env, NODE_ENV: 'test' });

async function signUp(displayName?: string) {
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

describe('/me (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    app = await buildApp(env);
    [alice, bob] = await Promise.all([signUp('Alice'), signUp()]);
  });

  it('rejects a forged token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns the profile and the personal workspace created at signup', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', headers: alice.auth });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.email).toBe(alice.email);
    expect(me.profile).toMatchObject({
      display_name: 'Alice',
      locale: 'fr',
      timezone: 'Europe/Paris',
    });
    expect(me.workspaces).toEqual([
      { id: expect.any(String), name: 'Espace personnel', role: 'owner' },
    ]);
  });

  it('updates the profile with validated input', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: alice.auth,
      payload: { display_name: '  Alice Martin  ', locale: 'en', timezone: 'America/New_York' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      display_name: 'Alice Martin',
      locale: 'en',
      timezone: 'America/New_York',
    });
  });

  it.each([
    [{ timezone: 'Mars/Olympus' }, /time zone/],
    [{ locale: 'de' }, /locale/],
    [{ display_name: 'x'.repeat(81) }, /display_name/],
    [{}, /Nothing to update/],
  ])('rejects invalid input %j', async (payload, message) => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: alice.auth,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
  });

  it('keeps tenants isolated', async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: '/me', headers: alice.auth }),
      app.inject({ method: 'GET', url: '/me', headers: bob.auth }),
    ]);
    const aliceWs = a.json().workspaces.map((w: { id: string }) => w.id);
    const bobWs = b.json().workspaces.map((w: { id: string }) => w.id);
    expect(bobWs).toHaveLength(1);
    expect(bobWs).not.toContain(aliceWs[0]);
    expect(b.json().profile.display_name).toBeNull();
  });

  it('enforces the 8-character password minimum on the server, not just in the UI', async () => {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false },
    });
    const { error } = await sb.auth.signUp({
      email: `it-${randomUUID()}@example.test`,
      password: 'Short7!',
    });
    expect(error?.code).toBe('weak_password');
  });
});
