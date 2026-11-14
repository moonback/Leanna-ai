import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderApp } from './test/render';
import { MODULES } from './modules';

function mockFetch(impl: () => Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
}

const ok = () =>
  Promise.resolve(
    new Response(JSON.stringify({ status: 'ok', version: '0.1.0', uptimeSeconds: 1 }), {
      status: 200,
    }),
  );

describe('app shell', () => {
  it('renders the dashboard with honest empty states', () => {
    mockFetch(ok);
    renderApp('/');
    expect(screen.getByRole('heading', { name: 'Bienvenue sur LEANA' })).toBeInTheDocument();
    expect(screen.getByText('Aucune mission pour l’instant.')).toBeInTheDocument();
  });

  it('only links modules that are implemented; the rest are disabled', () => {
    mockFetch(ok);
    renderApp('/');
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    const available = MODULES.filter((m) => m.phase === null);
    expect(nav.querySelectorAll('a')).toHaveLength(available.length);
    expect(nav.querySelectorAll('[aria-disabled="true"]')).toHaveLength(
      MODULES.length - available.length,
    );
  });

  it('shows a not-found page for unknown routes', () => {
    mockFetch(ok);
    renderApp('/nope');
    expect(screen.getByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
  });
});

describe('api status', () => {
  it('reports a connected API', async () => {
    mockFetch(ok);
    renderApp('/');
    expect(await screen.findByText('API connectée')).toBeInTheDocument();
  });

  it('reports an unreachable API and lets the user retry', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    renderApp('/');
    expect(await screen.findByText('API injoignable')).toBeInTheDocument();

    mockFetch(ok);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('API connectée')).toBeInTheDocument();
  });
});
