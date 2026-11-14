export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export type Health = { status: 'ok'; version: string; uptimeSeconds: number };

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch(`${API_URL}/health`, { signal });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}
