import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '@/router';
import { AuthProvider } from '@/auth/AuthProvider';

export function renderApp(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return router;
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

export const ME = {
  id: 'user-1',
  email: 'alice@example.test',
  profile: { display_name: 'Alice', avatar_url: null, locale: 'fr', timezone: 'Europe/Paris' },
  preferences: { ai_provider: null, ai_model: null },
  workspaces: [{ id: 'ws-1', name: 'Espace personnel', role: 'owner' }],
};

const GEMINI = {
  id: 'gemini',
  label: 'Google Gemini',
  configured: true,
  models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
  default_model: 'gemini-3.6-flash',
};
const OPENROUTER = {
  id: 'openrouter',
  label: 'OpenRouter',
  configured: false,
  models: ['anthropic/claude-haiku-5.5', 'mistralai/mistral-small-2603'],
  default_model: 'anthropic/claude-haiku-5.5',
};

/** Gemini configured, OpenRouter without key (the default server state in tests). */
export const AI_CONFIG = {
  configured: true,
  default: { provider: 'gemini', model: 'gemini-3.6-flash' },
  providers: [GEMINI, OPENROUTER],
};
export const AI_CONFIG_BOTH = {
  ...AI_CONFIG,
  providers: [GEMINI, { ...OPENROUTER, configured: true }],
};
export const AI_CONFIG_NONE = {
  configured: false,
  default: null,
  providers: [
    { ...GEMINI, configured: false },
    { ...OPENROUTER, configured: false },
  ],
};

/** An SSE response whose chunks deliberately split events mid-way, like a real network. */
export function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return Promise.resolve(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
}

/** Routes fetch calls to a fake API; override individual endpoints per test. */
export function mockApi(overrides: Record<string, () => Promise<Response>> = {}) {
  const handlers: Record<string, () => Promise<Response>> = {
    'GET /health': () => json({ status: 'ok', version: '0.3.0', uptimeSeconds: 1 }),
    'GET /me': () => json(ME),
    'GET /ai/config': () => json(AI_CONFIG),
    'GET /conversations': () => json([]),
    ...overrides,
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    const handler = handlers[key];
    return handler ? handler() : json({ error: `unmocked ${key}` }, 500);
  });
}

export { json };
