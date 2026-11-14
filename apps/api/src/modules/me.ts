import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';
import { requireAuth } from '../plugins/auth.js';

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

export async function meRoutes(app: FastifyInstance, opts: { aiModels: readonly string[] }) {
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
      const { db, userId, email } = requireAuth(req);
      const [profile, memberships, preferences] = await Promise.all([
        db.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).single(),
        db
          .from('memberships')
          .select('role, workspace:workspaces!inner(id, name)')
          .eq('user_id', userId)
          .order('created_at'),
        db.from('preferences').select('settings').eq('user_id', userId).single(),
      ]);
      if (profile.error) throw profile.error;
      if (memberships.error) throw memberships.error;
      if (preferences.error) throw preferences.error;

      const aiModel = preferences.data.settings?.ai_model;
      return {
        id: userId,
        email,
        profile: profile.data,
        preferences: { ai_model: opts.aiModels.includes(aiModel) ? aiModel : null },
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
      const { db, userId } = requireAuth(req);
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

  // "Configurer son IA": the chosen model must be on the server allowlist (null = default).
  app.patch(
    '/me/preferences',
    {
      schema: {
        tags: ['account'],
        summary: 'Update assistant preferences',
        security: [{ bearer: [] }],
      },
    },
    async (req) => {
      const { db, userId } = requireAuth(req);
      const parsed = z
        .object({ ai_model: z.enum(opts.aiModels as [string, ...string[]]).nullable() })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));

      const current = await db
        .from('preferences')
        .select('settings')
        .eq('user_id', userId)
        .single();
      if (current.error) throw current.error;
      const settings = { ...current.data.settings };
      if (parsed.data.ai_model) settings.ai_model = parsed.data.ai_model;
      else delete settings.ai_model;

      const { error } = await db.from('preferences').update({ settings }).eq('user_id', userId);
      if (error) throw error;
      return { ai_model: parsed.data.ai_model };
    },
  );
}
