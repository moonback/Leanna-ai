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
  preferences: AiPreference & { memory_enabled: boolean };
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[];
};
export type ProviderId = 'gemini' | 'openrouter';
/** null provider = server default; null model = the provider's default model. */
export type AiPreference = { ai_provider: ProviderId | null; ai_model: string | null };
export type AiProviderInfo = {
  id: ProviderId;
  label: string;
  configured: boolean;
  models: string[];
  default_model: string;
};
export type AiConfig = {
  configured: boolean;
  default: { provider: ProviderId; model: string } | null;
  /** null = memory search is keyword-only (no embeddings provider on the server). */
  embeddings: { provider: ProviderId; model: string } | null;
  providers: AiProviderInfo[];
};
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
  provider: ProviderId | null;
  model: string | null;
  error_code: string | null;
  created_at: string;
};

export type MemoryKind = 'fact' | 'preference' | 'goal' | 'relationship';
export type Memory = {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  source: 'manual' | 'conversation';
  source_message_id: string | null;
  status: 'active' | 'superseded';
  superseded_by: string | null;
  /** Has a vector of the server's current embeddings model (semantic search). */
  indexed: boolean;
  created_at: string;
  updated_at: string;
  score?: number;
};
/** The `memory` SSE event: what the assistant just learned from the user's message. */
export type MemoryChanges = {
  added: Memory[];
  updated: { previous_id: string; memory: Memory }[];
  forgotten: string[];
};

export const fetchHealth = (signal?: AbortSignal) => apiFetch<Health>('/health', { signal });
export const fetchMe = (signal?: AbortSignal) => apiFetch<Me>('/me', { signal });
export const updateProfile = (
  patch: Partial<Pick<Profile, 'display_name' | 'locale' | 'timezone'>>,
) => apiFetch<Profile>('/me/profile', { method: 'PATCH', body: JSON.stringify(patch) });
export const updatePreferences = (prefs: AiPreference | { memory_enabled: boolean }) =>
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

export const fetchMemories = (
  params: { status?: Memory['status']; q?: string },
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.q) query.set('q', params.q);
  const qs = query.toString();
  return apiFetch<Memory[]>(`/memories${qs ? `?${qs}` : ''}`, { signal });
};
export const createMemory = (body: { content: string; kind: MemoryKind }) =>
  apiFetch<Memory>('/memories', { method: 'POST', body: JSON.stringify(body) });
export const updateMemory = (
  id: string,
  patch: Partial<Pick<Memory, 'content' | 'kind' | 'importance'>>,
) => apiFetch<Memory>(`/memories/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const restoreMemory = (id: string) =>
  apiFetch<Memory>(`/memories/${id}/restore`, { method: 'POST', body: '{}' });
export const deleteMemory = (id: string) => apiFetch<void>(`/memories/${id}`, { method: 'DELETE' });
export const clearMemories = () =>
  apiFetch<{ deleted: number }>('/memories', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
export const reindexMemories = () =>
  apiFetch<{ indexed: number; remaining: number }>('/memories/reindex', {
    method: 'POST',
    body: '{}',
  });

export type MissionStatus =
  'planning' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Mission = {
  id: string;
  title: string;
  goal: string;
  status: MissionStatus;
  provider: ProviderId | null;
  model: string | null;
  result: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};
export type MissionStep = {
  id: string;
  position: number;
  title: string;
  instruction: string;
  requires_approval: boolean;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempt: number;
  output: string | null;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
};
export type Approval = {
  id: string;
  mission_id: string;
  step_id: string | null;
  kind: 'plan' | 'step';
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  decided_at: string | null;
  created_at: string;
};
export type MissionDetail = Mission & { steps: MissionStep[]; approvals: Approval[] };
export type ActivityEntry = {
  id: string;
  mission_id: string | null;
  kind: string;
  summary: string;
  created_at: string;
};
export type AppNotification = {
  id: string;
  title: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

export const fetchMissionsConfig = (signal?: AbortSignal) =>
  apiFetch<{ configured: boolean }>('/missions/config', { signal });
export const fetchMissions = (signal?: AbortSignal) => apiFetch<Mission[]>('/missions', { signal });
export const fetchMission = (id: string, signal?: AbortSignal) =>
  apiFetch<MissionDetail>(`/missions/${id}`, { signal });
export const createMission = (goal: string) =>
  apiFetch<Mission>('/missions', { method: 'POST', body: JSON.stringify({ goal }) });
export const cancelMission = (id: string) =>
  apiFetch<Mission>(`/missions/${id}/cancel`, { method: 'POST', body: '{}' });
export const fetchPendingApprovals = (signal?: AbortSignal) =>
  apiFetch<(Approval & { mission: { title: string } })[]>('/approvals', { signal });
export const decideApproval = (id: string, decision: 'approved' | 'rejected') =>
  apiFetch<Approval>(`/approvals/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
export const fetchActivity = (limit = 50, signal?: AbortSignal) =>
  apiFetch<ActivityEntry[]>(`/activity?limit=${limit}`, { signal });
export const fetchNotifications = (signal?: AbortSignal) =>
  apiFetch<{ items: AppNotification[]; unread: number }>('/notifications', { signal });
export const markNotificationsRead = (body: { ids: string[] } | { all: true }) =>
  apiFetch<{ marked: number }>('/notifications/read', {
    method: 'POST',
    body: JSON.stringify(body),
  });

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
