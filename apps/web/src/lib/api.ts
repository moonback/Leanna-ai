import { supabase } from './supabase';
import { createSseParser, type SseEvent } from './sse';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
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
  return res;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  return res.status === 204 ? (undefined as T) : res.json();
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
  preferences: { ai_model: string | null };
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[];
};
export type AiConfig = { configured: boolean; models: string[]; default_model: string | null };
export type Conversation = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'error' | 'interrupted';
  model: string | null;
  error_code: string | null;
  created_at: string;
};

export const fetchHealth = (signal?: AbortSignal) => apiFetch<Health>('/health', { signal });
export const fetchMe = (signal?: AbortSignal) => apiFetch<Me>('/me', { signal });
export const updateProfile = (
  patch: Partial<Pick<Profile, 'display_name' | 'locale' | 'timezone'>>,
) => apiFetch<Profile>('/me/profile', { method: 'PATCH', body: JSON.stringify(patch) });
export const updatePreferences = (prefs: { ai_model: string | null }) =>
  apiFetch('/me/preferences', { method: 'PATCH', body: JSON.stringify(prefs) });

export const fetchAiConfig = (signal?: AbortSignal) => apiFetch<AiConfig>('/ai/config', { signal });
export const fetchConversations = (signal?: AbortSignal) =>
  apiFetch<Conversation[]>('/conversations', { signal });
export const createConversation = () =>
  apiFetch<Conversation>('/conversations', { method: 'POST', body: '{}' });
export const deleteConversation = (id: string) =>
  apiFetch<void>(`/conversations/${id}`, { method: 'DELETE' });
export const fetchMessages = (id: string, signal?: AbortSignal) =>
  apiFetch<ChatMessage[]>(`/conversations/${id}/messages`, { signal });

/** Sends a message and reports each Server-Sent Event as it arrives. */
export async function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
) {
  const res = await request(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
    signal,
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const parser = createSseParser(onEvent);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
  }
}
