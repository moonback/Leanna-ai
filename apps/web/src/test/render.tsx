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
  workspaces: [{ id: 'ws-1', name: 'Espace personnel', role: 'owner' }],
};

/** Routes fetch calls to a fake API; override individual endpoints per test. */
export function mockApi(overrides: Record<string, () => Promise<Response>> = {}) {
  const handlers: Record<string, () => Promise<Response>> = {
    'GET /health': () => json({ status: 'ok', version: '0.2.0', uptimeSeconds: 1 }),
    'GET /me': () => json(ME),
    ...overrides,
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    const handler = handlers[key];
    return handler ? handler() : json({ error: `unmocked ${key}` }, 500);
  });
}

export { json };
