import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http.js';
import { requireAuth } from '../plugins/auth.js';
import type { Gateway } from '../ai/gateway.js';
import { effectivePreference } from '../ai/catalog.js';
import { PROVIDER_IDS } from '../ai/types.js';

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

const PreferencesBody = z
  .object({ ai_provider: z.enum(PROVIDER_IDS).nullable(), ai_model: z.string().min(1).nullable() })
  .strict();

export async function meRoutes(app: FastifyInstance, opts: { gateway: Gateway | null }) {
  const { gateway } = opts;
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

      return {
        id: userId,
        email,
        profile: profile.data,
        preferences: effectivePreference(preferences.data.settings, gateway),
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

  // "Configurer son IA": provider and model must be configured and allowlisted on the server.
  // null provider = server default; null model = the chosen provider's default model.
  app.patch(
    '/me/preferences',
    {
      schema: {
        tags: ['account'],
        summary: 'Choose the AI provider and model',
        security: [{ bearer: [] }],
        body: z.toJSONSchema(PreferencesBody, { target: 'draft-07' }),
      },
    },
    async (req) => {
      const { db, userId } = requireAuth(req);
      const parsed = PreferencesBody.safeParse(req.body);
      if (!parsed.success) throw httpError(400, z.prettifyError(parsed.error));
      const { ai_provider, ai_model } = parsed.data;

      if (!ai_provider && ai_model) throw httpError(400, 'Choose a provider before a model');
      if (ai_provider && !gateway?.providers[ai_provider]) {
        throw httpError(400, 'This AI provider is not configured on the server');
      }
      if (
        ai_provider &&
        ai_model &&
        !gateway!.isAllowed({ provider: ai_provider, model: ai_model })
      ) {
        throw httpError(400, 'This model is not allowed for this provider');
      }

      const current = await db
        .from('preferences')
        .select('settings')
        .eq('user_id', userId)
        .single();
      if (current.error) throw current.error;
      const settings = { ...current.data.settings };
      delete settings.ai_provider;
      delete settings.ai_model;
      if (ai_provider) settings.ai_provider = ai_provider;
      if (ai_model) settings.ai_model = ai_model;

      const { error } = await db.from('preferences').update({ settings }).eq('user_id', userId);
      if (error) throw error;
      return { ai_provider, ai_model };
    },
  );
}
