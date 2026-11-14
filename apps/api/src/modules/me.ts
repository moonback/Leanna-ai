import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const ProfilePatch = z
  .object({
    display_name: z
      .string()
      .trim()
      .max(80)
      .transform((v) => v || null)
      .nullable(),
    locale: z.enum(['fr', 'en']),
    timezone: z.string().max(64).refine(isTimeZone, 'Unknown time zone'),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to update');

const PROFILE_COLUMNS = 'display_name, avatar_url, locale, timezone';

function auth(req: FastifyRequest) {
  if (!req.auth) throw httpError(401, 'Unauthenticated');
  return req.auth;
}

export async function meRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/me',
    {
      schema: {
        tags: ['account'],
        summary: 'Current user, profile and workspaces',
        security: [{ bearer: [] }],
      },
    },
    async (req) => {
      const { db, userId, email } = auth(req);
      const [profile, memberships] = await Promise.all([
        db.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).single(),
        db
          .from('memberships')
          .select('role, workspace:workspaces!inner(id, name)')
          .eq('user_id', userId)
          .order('created_at'),
      ]);
      if (profile.error) throw profile.error;
      if (memberships.error) throw memberships.error;

      return {
        id: userId,
        email,
        profile: profile.data,
        workspaces: memberships.data.map((m) => ({ ...m.workspace, role: m.role })),
      };
    },
  );

  app.patch(
    '/me/profile',
    {
      schema: {
        tags: ['account'],
        summary: 'Update the current user profile',
        security: [{ bearer: [] }],
        body: z.toJSONSchema(ProfilePatch, { target: 'draft-07', io: 'input' }),
      },
    },
    async (req) => {
      const { db, userId } = auth(req);
      const parsed = ProfilePatch.safeParse(req.body);
      if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));

      const { data, error } = await db
        .from('profiles')
        .update(parsed.data)
        .eq('id', userId)
        .select(PROFILE_COLUMNS)
        .single();
      // Database-side validation (invalid value / check constraint) is a client error.
      if (error && ['22023', '23514'].includes(error.code)) throw httpError(400, error.message);
      if (error) throw error;
      return data;
    },
  );
}
