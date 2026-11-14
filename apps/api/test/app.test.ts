import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

// Unit scope: Supabase is never reached by these routes.
const env = loadEnv({
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_PUBLISHABLE_KEY: 'unused',
});

describe('api', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: '0.2.0' });
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
});
