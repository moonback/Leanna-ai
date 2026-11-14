import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { httpError } from '../src/http.js';

// Unit scope: Supabase is never reached by these routes.
const base = {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_PUBLISHABLE_KEY: 'unused',
};
const env = loadEnv(base);

describe('api', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: '0.7.0' });
  });

  it('exposes an OpenAPI document listing the routes', async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toEqual(
      expect.arrayContaining(['/health', '/me', '/me/profile']),
    );
  });

  it('only allows configured CORS origins', async () => {
    const app = await buildApp(env);
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects requests without a bearer token before touching Supabase', async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Missing bearer token' });
  });

  it('rejects an invalid environment', () => {
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow(/Invalid environment/);
  });

  it('hides unexpected error details but keeps intentional HTTP errors', async () => {
    const app = await buildApp(env);
    app.get('/boom', async () => {
      throw Object.assign(new Error('relation "secret_table" does not exist'), { code: '42P01' });
    });
    app.get('/busy', async () => {
      throw httpError(503, 'AI not configured');
    });
    const boom = await app.inject({ method: 'GET', url: '/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: 'Internal error' });
    const busy = await app.inject({ method: 'GET', url: '/busy' });
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ error: 'AI not configured' });
  });

  it('treats an empty GEMINI_API_KEY (copied from .env.example) as "no key"', () => {
    expect(loadEnv({ ...base, GEMINI_API_KEY: '' }).GEMINI_API_KEY).toBeUndefined();
  });

  it('keeps each provider default model inside its allowlist', () => {
    expect(() => loadEnv({ ...base, GEMINI_MODELS: 'a,b', GEMINI_DEFAULT_MODEL: 'c' })).toThrow(
      /GEMINI_DEFAULT_MODEL/,
    );
    expect(() =>
      loadEnv({ ...base, OPENROUTER_MODELS: 'x/a', OPENROUTER_DEFAULT_MODEL: 'x/b' }),
    ).toThrow(/OPENROUTER_DEFAULT_MODEL/);
    expect(() => loadEnv({ ...base, AI_DEFAULT_PROVIDER: 'acme' })).toThrow(/AI_DEFAULT_PROVIDER/);
  });
});
