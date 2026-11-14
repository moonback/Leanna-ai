import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, ME, mockApi, renderApp } from './test/render';
import { fakeAuth, supabase } from './test/fakeSupabase';
import { safeNext } from './auth/RequireAuth';
import { MODULES } from './modules';

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('auth guard', () => {
  it('sends signed-out users to the login page, keeping the destination', async () => {
    mockApi();
    const router = renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Fsettings');
  });

  it.each([
    ['/settings', '/settings'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    [null, '/'],
  ])('safeNext(%j) → %s', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });
});

describe('login', () => {
  it('shows a readable error on bad credentials', async () => {
    mockApi();
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
      error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
    } as never);
    renderApp('/login');
    fill('E-mail', 'alice@example.test');
    fill('Mot de passe', 'wrong-password');
    fireEvent.click(await screen.findByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou mot de passe incorrect.');
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'alice@example.test',
      password: 'wrong-password',
    });
  });

  it('opens the requested page after signing in', async () => {
    mockApi();
    vi.mocked(supabase.auth.signInWithPassword).mockImplementation(async () => {
      fakeAuth.signIn();
      return { error: null } as never;
    });
    const router = renderApp('/login?next=%2Fsettings');
    fill('E-mail', 'alice@example.test');
    fill('Mot de passe', 'correct-password');
    fireEvent.click(await screen.findByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('heading', { name: 'Paramètres' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings');
  });
});

describe('signup', () => {
  it('asks to confirm the e-mail when no session is returned', async () => {
    mockApi();
    vi.mocked(supabase.auth.signUp).mockResolvedValue({
      data: { session: null, user: {} },
      error: null,
    } as never);
    renderApp('/signup');
    fill('Nom affiché', ' Alice ');
    fill('E-mail', 'alice@example.test');
    fill('Mot de passe', 'long-enough-pw');
    fireEvent.click(await screen.findByRole('button', { name: 'Créer mon compte' }));

    expect(
      await screen.findByRole('heading', { name: 'Vérifiez vos e-mails' }),
    ).toBeInTheDocument();
    expect(vi.mocked(supabase.auth.signUp).mock.calls[0]?.[0]).toMatchObject({
      email: 'alice@example.test',
      options: { data: { display_name: 'Alice' } },
    });
  });
});

describe('signed-in shell', () => {
  it('greets the user and only links implemented modules', async () => {
    fakeAuth.signIn();
    mockApi();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Bonjour, Alice' })).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    const available = MODULES.filter((m) => m.phase === null);
    expect(nav.querySelectorAll('a')).toHaveLength(available.length);
    expect(nav.querySelectorAll('[aria-disabled="true"]')).toHaveLength(
      MODULES.length - available.length,
    );
  });

  it('sends the access token to the API', async () => {
    fakeAuth.signIn();
    const fetchSpy = mockApi();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Bonjour, Alice' });
    const meCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/me'));
    expect(new Headers(meCall?.[1]?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('signs out to a plain login page (no stale destination)', async () => {
    fakeAuth.signIn();
    mockApi();
    const router = renderApp('/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Se déconnecter' }));
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('shows a not-found page for unknown routes', async () => {
    fakeAuth.signIn();
    mockApi();
    renderApp('/nope');
    expect(await screen.findByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
  });

  it('reports an unreachable API and lets the user retry', async () => {
    fakeAuth.signIn();
    let healthy = false;
    mockApi({
      'GET /health': () =>
        healthy
          ? json({ status: 'ok', version: '0.2.0', uptimeSeconds: 1 })
          : Promise.reject(new TypeError('Failed to fetch')),
    });
    renderApp('/');
    expect(await screen.findByText('API injoignable')).toBeInTheDocument();
    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('API connectée')).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('saves the profile through the API', async () => {
    fakeAuth.signIn();
    const fetchSpy = mockApi({
      'PATCH /me/profile': () => json({ ...ME.profile, display_name: 'Alice M.' }),
    });
    renderApp('/settings');
    expect(await screen.findByDisplayValue('Alice')).toBeInTheDocument();
    expect(screen.getByText('Propriétaire')).toBeInTheDocument();

    fill('Nom affiché', 'Alice M.');
    fill('Langue', 'en');
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText('Profil enregistré.')).toBeInTheDocument();
    const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      display_name: 'Alice M.',
      locale: 'en',
      timezone: 'Europe/Paris',
    });
  });

  it('shows API validation errors', async () => {
    fakeAuth.signIn();
    mockApi({ 'PATCH /me/profile': () => json({ error: 'Unknown time zone' }, 400) });
    renderApp('/settings');
    await screen.findByDisplayValue('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unknown time zone'));
  });
});
