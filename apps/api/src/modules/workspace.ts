import type { SupabaseClient } from '@supabase/supabase-js';

/** The user's default workspace, or the first one they belong to. */
export async function defaultWorkspaceId(db: SupabaseClient, userId: string): Promise<string> {
  const prefs = await db
    .from('preferences')
    .select('default_workspace_id')
    .eq('user_id', userId)
    .single();
  if (prefs.error) throw prefs.error;
  if (prefs.data.default_workspace_id) return prefs.data.default_workspace_id;
  const first = await db
    .from('memberships')
    .select('workspace_id')
    .eq('user_id', userId)
    .limit(1)
    .single();
  if (first.error) throw first.error;
  return first.data.workspace_id;
}

/** Memory is on unless the user turned it off. */
export const memoryEnabled = (settings: unknown) =>
  (settings as { memory_enabled?: unknown } | null)?.memory_enabled !== false;
