import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  AI_CONFIG,
  AI_CONFIG_NONE,
  json,
  ME,
  mockApi,
  renderApp,
  sseResponse,
} from './test/render';
import { fakeAuth } from './test/fakeSupabase';

const C1 = '11111111-1111-4111-8111-111111111111';
const memory = (id: string, content: string, extra = {}) => ({
  id,
  kind: 'fact',
  content,
  importance: 3,
  source: 'manual',
  source_message_id: null,
  status: 'active',
  superseded_by: null,
  indexed: true,
  created_at: '2026-11-14T10:00:00Z',
  updated_at: '2026-11-14T10:00:00Z',
  ...extra,
});
const callsTo = (spy: ReturnType<typeof mockApi>, method: string, path: string) =>
  spy.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && new URL(String(url)).pathname === path,
  );

describe('memory page', () => {
  it('lists what LEANA knows, with its origin', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /memories': () =>
        json([
          memory('m1', 'Travaille chez Acme', { source: 'conversation' }),
          memory('m2', 'Préfère le tutoiement', { kind: 'preference' }),
        ]),
    });
    renderApp('/memory');
    const list = await screen.findByRole('region', { name: 'Souvenirs' });
    expect(await within(list).findByText('Travaille chez Acme')).toBeInTheDocument();
    expect(within(list).getByText(/Retenu d’une conversation/)).toBeInTheDocument();
    expect(within(list).getByText('Préférence')).toBeInTheDocument();
    expect(screen.getByText('Recherche hybride : mots-clés et sens.')).toBeInTheDocument();
    // Mémoire is now a real module in the sidebar.
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    expect(within(nav).getByRole('link', { name: 'Mémoire' })).toHaveAttribute('href', '/memory');
  });

  it('teaches a new memory and reports a duplicate', async () => {
    fakeAuth.signIn();
    let attempts = 0;
    const spy = mockApi({
      'GET /memories': () => json([]),
      'POST /memories': () =>
        ++attempts === 1
          ? json(memory('m1', 'Parle italien'), 201)
          : json({ error: 'LEANA already knows this' }, 409),
    });
    renderApp('/memory');
    expect(await screen.findByText(/LEANA ne sait encore rien de vous/)).toBeInTheDocument();

    const input = screen.getByLabelText('Ce que LEANA doit retenir');
    fireEvent.change(input, { target: { value: '  Parle italien ' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'preference' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retenir' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(JSON.parse(String(callsTo(spy, 'POST', '/memories')[0]![1]!.body))).toEqual({
      content: 'Parle italien',
      kind: 'preference',
    });

    fireEvent.change(input, { target: { value: 'Parle italien' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retenir' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('LEANA le sait déjà.');
  });

  it('corrects, then deletes a memory after confirmation', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /memories': () => json([memory('m1', 'Habite à Paris')]),
      'PATCH /memories/m1': () => json(memory('m1', 'Habite à Lyon')),
      'DELETE /memories/m1': () => Promise.resolve(new Response(null, { status: 204 })),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/memory');

    fireEvent.click(await screen.findByRole('button', { name: 'Corriger « Habite à Paris »' }));
    fireEvent.change(screen.getByLabelText('Corriger le souvenir'), {
      target: { value: 'Habite à Lyon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(callsTo(spy, 'PATCH', '/memories/m1')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'PATCH', '/memories/m1')[0]![1]!.body))).toEqual({
      content: 'Habite à Lyon',
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Supprimer « Habite à Paris »' }));
    await waitFor(() => expect(callsTo(spy, 'DELETE', '/memories/m1')).toHaveLength(1));
  });

  it('shows replaced memories in the history tab and restores one', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /memories': () =>
        json([memory('m1', 'Habite à Paris', { status: 'superseded', superseded_by: 'm2' })]),
      'POST /memories/m1/restore': () => json(memory('m1', 'Habite à Paris')),
    });
    renderApp('/memory');
    fireEvent.click(await screen.findByRole('tab', { name: 'Historique' }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([url]) => String(url).includes('/memories?status=superseded')),
      ).toBe(true),
    );
    expect(
      await screen.findByText(/remplacé par une information plus récente/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restaurer « Habite à Paris »' }));
    await waitFor(() => expect(callsTo(spy, 'POST', '/memories/m1/restore')).toHaveLength(1));
  });

  it('searches, and says when search is keyword-only', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /ai/config': () => json(AI_CONFIG_NONE),
      'GET /memories': () => json([]),
    });
    renderApp('/memory');
    expect(await screen.findByText(/Recherche par mots-clés uniquement/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Rechercher dans la mémoire'), {
      target: { value: 'Lyon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rechercher' }));
    expect(
      await screen.findByText('Aucun souvenir ne correspond à cette recherche.'),
    ).toBeInTheDocument();
    expect(
      spy.mock.calls.some(([url]) => String(url).endsWith('/memories?status=active&q=Lyon')),
    ).toBe(true);
  });

  it('erases everything only after confirmation', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /memories': () => json([memory('m1', 'Habite à Paris')]),
      'DELETE /memories': () => json({ deleted: 1 }),
    });
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderApp('/memory');
    const erase = await screen.findByRole('button', { name: 'Tout effacer' });
    fireEvent.click(erase);
    expect(callsTo(spy, 'DELETE', '/memories')).toHaveLength(0);
    fireEvent.click(erase);
    await waitFor(() => expect(callsTo(spy, 'DELETE', '/memories')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'DELETE', '/memories')[0]![1]!.body))).toEqual({
      confirm: true,
    });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('warns when memory is turned off', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /me': () => json({ ...ME, preferences: { ...ME.preferences, memory_enabled: false } }),
      'GET /memories': () => json([]),
    });
    renderApp('/memory');
    expect(await screen.findByText(/La mémoire est désactivée/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Réactiver dans Paramètres' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });
});

describe('memory in settings and chat', () => {
  it('turns memory off from settings', async () => {
    fakeAuth.signIn();
    const spy = mockApi({ 'PATCH /me/preferences': () => json({}) });
    renderApp('/settings');
    const toggle = await screen.findByRole('checkbox', { name: 'Activer la mémoire' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(callsTo(spy, 'PATCH', '/me/preferences')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'PATCH', '/me/preferences')[0]![1]!.body))).toEqual({
      memory_enabled: false,
    });
  });

  it('shows what was just learned under the reply, after the thread moves to its new id', async () => {
    fakeAuth.signIn();
    const changes = {
      added: [memory('m1', 'Travaille chez Acme', { source: 'conversation' })],
      updated: [{ previous_id: 'm0', memory: memory('m2', 'Habite à Lyon') }],
      forgotten: [],
    };
    mockApi({
      'GET /ai/config': () => json(AI_CONFIG),
      'POST /conversations': () =>
        json({ id: C1, title: null, created_at: '', updated_at: '' }, 201),
      [`GET /conversations/${C1}/messages`]: () => json([]),
      [`POST /conversations/${C1}/messages`]: () =>
        sseResponse([
          'event: start\ndata: {"userMessageId":"u1"}\n\n',
          'event: delta\ndata: {"text":"Noté !"}\n\nevent: done\ndata: {"message":{}}\n\n',
          `event: memory\ndata: ${JSON.stringify(changes)}\n\n`,
        ]),
    });
    renderApp('/assistant');
    const composer = await screen.findByLabelText('Message pour LEANA');
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, {
      target: { value: 'Je travaille chez Acme et j’habite à Lyon maintenant' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    const note = (await screen.findByText('Retenu : Travaille chez Acme')).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(note).toHaveTextContent('Mis à jour : Habite à Lyon');
    expect(within(note).getByRole('link', { name: 'Gérer la mémoire' })).toHaveAttribute(
      'href',
      '/memory',
    );
  });
});
