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
  agent_id: string | null;
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
  failures: number;
  output: string | null;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
};
export type Approval = {
  id: string;
  mission_id: string;
  step_id: string | null;
  kind: 'plan' | 'step' | 'tool';
  tool_call_id: string | null;
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  decided_at: string | null;
  created_at: string;
};
export type ToolCall = {
  id: string;
  step_id: string;
  tool: string;
  input: unknown;
  status: 'denied' | 'pending_approval' | 'rejected' | 'running' | 'succeeded' | 'failed';
  output: unknown;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};
export type MissionDetail = Mission & {
  agent: { id: string; name: string } | null;
  steps: MissionStep[];
  approvals: Approval[];
  tool_calls: ToolCall[];
};
export type ToolInfo = {
  name: string;
  risk: 'read' | 'write' | 'sensitive';
  description: string;
  input: unknown;
};
export type Agent = {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  tools: string[];
  auto_write: boolean;
  provider: ProviderId | null;
  model: string | null;
  created_at: string;
  updated_at: string;
};
export type AgentInput = Partial<
  Pick<
    Agent,
    'name' | 'description' | 'instructions' | 'tools' | 'auto_write' | 'provider' | 'model'
  >
>;

export const fetchTools = (signal?: AbortSignal) => apiFetch<ToolInfo[]>('/tools', { signal });
export const fetchAgents = (signal?: AbortSignal) => apiFetch<Agent[]>('/agents', { signal });
export const createAgent = (body: AgentInput) =>
  apiFetch<Agent>('/agents', { method: 'POST', body: JSON.stringify(body) });
export const updateAgent = (id: string, patch: AgentInput) =>
  apiFetch<Agent>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteAgent = (id: string) => apiFetch<void>(`/agents/${id}`, { method: 'DELETE' });
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
export const createMission = (body: { goal: string; agent_id?: string | null }) =>
  apiFetch<Mission>('/missions', { method: 'POST', body: JSON.stringify(body) });
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

// ---------------------------------------------------------------- workspace data

export type Project = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
};
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type Task = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};
export type DocumentSummary = {
  id: string;
  project_id: string | null;
  title: string;
  excerpt?: string;
  snippet?: string;
  length?: number;
  updated_at: string;
};
export type Doc = {
  id: string;
  project_id: string | null;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
};
export type CalendarEvent = {
  id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  created_at: string;
  updated_at: string;
};

const qs = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  return q ? `?${q}` : '';
};
const send = <T>(method: string, path: string, body?: unknown) =>
  apiFetch<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const fetchProjects = (
  status: 'active' | 'archived' | 'all' = 'active',
  signal?: AbortSignal,
) => apiFetch<Project[]>(`/projects${qs({ status })}`, { signal });
export const createProject = (body: Partial<Project>) => send<Project>('POST', '/projects', body);
export const updateProject = (id: string, patch: Partial<Project>) =>
  send<Project>('PATCH', `/projects/${id}`, patch);
export const deleteProject = (id: string) => send<void>('DELETE', `/projects/${id}`);

export const fetchTasks = (
  params: { status?: string; project_id?: string; due_before?: string; limit?: string },
  signal?: AbortSignal,
) => apiFetch<Task[]>(`/tasks${qs(params)}`, { signal });
export const createTask = (body: Partial<Task>) => send<Task>('POST', '/tasks', body);
export const updateTask = (id: string, patch: Partial<Task>) =>
  send<Task>('PATCH', `/tasks/${id}`, patch);
export const deleteTask = (id: string) => send<void>('DELETE', `/tasks/${id}`);

export const fetchDocuments = (params: { q?: string; project_id?: string }, signal?: AbortSignal) =>
  apiFetch<DocumentSummary[]>(`/documents${qs(params)}`, { signal });
export const fetchDocument = (id: string, signal?: AbortSignal) =>
  apiFetch<Doc>(`/documents/${id}`, { signal });
export const createDocument = (body: Partial<Doc>) => send<Doc>('POST', '/documents', body);
export const updateDocument = (id: string, patch: Partial<Doc>) =>
  send<Doc>('PATCH', `/documents/${id}`, patch);
export const deleteDocument = (id: string) => send<void>('DELETE', `/documents/${id}`);

export const fetchEvents = (range: { from?: string; to?: string }, signal?: AbortSignal) =>
  apiFetch<CalendarEvent[]>(`/events${qs(range)}`, { signal });
export const createEvent = (body: Partial<CalendarEvent>) =>
  send<CalendarEvent>('POST', '/events', body);
export const updateEvent = (id: string, patch: Partial<CalendarEvent>) =>
  send<CalendarEvent>('PATCH', `/events/${id}`, patch);
export const deleteEvent = (id: string) => send<void>('DELETE', `/events/${id}`);

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
