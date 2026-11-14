import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env.js';
import { httpError } from '../http.js';

export type AuthContext = {
  userId: string;
  email: string | null;
  /** Supabase client acting as the caller: every query goes through RLS. */
  db: SupabaseClient;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
}

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/** Registers `app.authenticate`, a preHandler that verifies the Supabase access token. */
export function setupAuth(app: FastifyInstance, env: Env) {
  const verifier = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: noSession,
  });

  app.decorateRequest('auth', null);
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw httpError(401, 'Missing bearer token');

    const { data, error } = await verifier.auth.getClaims(token);
    const claims = data?.claims;
    // Reject anon/service tokens: only signed-in users reach protected routes.
    if (error || !claims?.sub || claims.role !== 'authenticated') {
      throw httpError(401, 'Invalid or expired token');
    }

    req.auth = {
      userId: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      db: createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        auth: noSession,
        global: { headers: { Authorization: `Bearer ${token}` } },
      }),
    };
  });
}
