import { supabase } from './supabase';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? `Erreur ${res.status}`);
  }
  return res.json();
}

export type Health = { status: 'ok'; version: string; uptimeSeconds: number };
export type Profile = {
  display_name: string | null;
  avatar_url: string | null;
  locale: 'fr' | 'en';
  timezone: string;
};
export type Me = {
  id: string;
  email: string | null;
  profile: Profile;
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[];
};

export const fetchHealth = (signal?: AbortSignal) => apiFetch<Health>('/health', { signal });
export const fetchMe = (signal?: AbortSignal) => apiFetch<Me>('/me', { signal });
export const updateProfile = (
  patch: Partial<Pick<Profile, 'display_name' | 'locale' | 'timezone'>>,
) => apiFetch<Profile>('/me/profile', { method: 'PATCH', body: JSON.stringify(patch) });
