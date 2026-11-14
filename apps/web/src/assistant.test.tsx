import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  AI_CONFIG,
  AI_CONFIG_BOTH,
  AI_CONFIG_NONE,
  json,
  ME,
  mockApi,
  renderApp,
  sseResponse,
} from './test/render';
import { fakeAuth } from './test/fakeSupabase';

const C1 = '11111111-1111-4111-8111-111111111111';
const conversation = (id: string, title: string | null) => ({
  id,
  title,
  created_at: '2026-11-14T10:00:00Z',
  updated_at: '2026-11-14T10:00:00Z',
});
const message = (id: string, role: 'user' | 'assistant', content: string, extra = {}) => ({
  id,
  role,
  content,
  status: 'complete',
  model: role === 'assistant' ? 'gemini-3.8-flash' : null,
  error_code: null,
  created_at: '2026-11-14T10:00:00Z',
  ...extra,
});

const composer = () => screen.getByLabelText('Message pour LEANA');

describe('assistant', () => {
  it('explains that the assistant is not configured and blocks sending', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /ai/config': () => json(AI_CONFIG_NONE),
    });
    renderApp('/assistant');
    expect(await screen.findByText(/n’est pas configuré sur ce serveur/)).toBeInTheDocument();
    expect(composer()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  });

  it('shows the history, including a failed answer with a readable reason', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /conversations': () => json([conversation(C1, 'Voyage à Lyon')]),
      [`GET /conversations/${C1}/messages`]: () =>
        json([
          message('m1', 'user', 'Quels trains ?'),
          message('m2', 'assistant', 'Il y a', { status: 'error', error_code: 'timeout' }),
        ]),
    });
    renderApp(`/assistant/${C1}`);
    const log = await screen.findByRole('log', { name: 'Messages' });
    expect(await within(log).findByText('Quels trains ?')).toBeInTheDocument();
    expect(within(log).getByText('Le modèle n’a pas répondu à temps.')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Voyage à Lyon' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('starts a conversation, streams the reply, then shows the stored version', async () => {
    fakeAuth.signIn();
    let sent = false;
    const fetchSpy = mockApi({
      'POST /conversations': () => json(conversation(C1, null), 201),
      [`POST /conversations/${C1}/messages`]: () => {
        sent = true;
        return sseResponse([
          'event: start\ndata: {"userMessageId":"m1","model":"gemini-3.8-flash"}\n\nevent: de',
          'lta\ndata: {"text":"Bonjour "}\n\n',
          'event: delta\ndata: {"text":"Alice !"}\n\nevent: done\ndata: {"message":{}}\n\n',
        ]);
      },
      [`GET /conversations/${C1}/messages`]: () =>
        json(
          sent
            ? [message('m1', 'user', 'Salut'), message('m2', 'assistant', 'Bonjour Alice !')]
            : [],
        ),
    });
    const router = renderApp('/assistant');
    await waitFor(() => expect(composer()).toBeEnabled());

    fireEvent.change(composer(), { target: { value: 'Salut' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });

    await waitFor(() => expect(router.state.location.pathname).toBe(`/assistant/${C1}`));
    // The thread remounts on navigation: always query the current one, not a stale node.
    await waitFor(() => {
      const log = screen.getByRole('log', { name: 'Messages' });
      expect(log).toHaveAttribute('aria-busy', 'false');
      expect(within(log).getByText('Bonjour Alice !')).toBeInTheDocument();
      expect(within(log).getByText('Salut')).toBeInTheDocument();
    });
    expect(composer()).toHaveValue('');

    const post = fetchSpy.mock.calls.find(([url]) => String(url).endsWith(`${C1}/messages`));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ content: 'Salut' });
  });

  it('gives the text back when the daily quota is reached', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /conversations': () => json([conversation(C1, 'Quota')]),
      [`GET /conversations/${C1}/messages`]: () => json([]),
      [`POST /conversations/${C1}/messages`]: () => json({ error: 'Daily AI quota reached' }, 429),
    });
    renderApp(`/assistant/${C1}`);
    await waitFor(() => expect(composer()).toBeEnabled());
    fireEvent.change(composer(), { target: { value: 'Encore une question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Quota IA quotidien atteint');
    expect(composer()).toHaveValue('Encore une question');
  });

  it('deletes a conversation only after confirmation', async () => {
    fakeAuth.signIn();
    let deleted = false;
    const fetchSpy = mockApi({
      'GET /conversations': () => json(deleted ? [] : [conversation(C1, 'À supprimer')]),
      [`DELETE /conversations/${C1}`]: () => {
        deleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderApp('/assistant');
    const remove = await screen.findByRole('button', { name: 'Supprimer « À supprimer »' });

    fireEvent.click(remove);
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(remove);
    expect(await screen.findByText('Aucune conversation pour l’instant.')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe('AI settings', () => {
  const lastPatch = (spy: ReturnType<typeof mockApi>) => {
    const call = spy.mock.calls.findLast(([url]) => String(url).endsWith('/me/preferences'));
    return JSON.parse(String(call?.[1]?.body));
  };

  it('lets the user pick OpenRouter and one of its models', async () => {
    fakeAuth.signIn();
    const fetchSpy = mockApi({
      'GET /ai/config': () => json(AI_CONFIG_BOTH),
      'PATCH /me/preferences': () => json({}),
    });
    renderApp('/settings');
    const provider = await screen.findByLabelText('Fournisseur');
    expect(screen.getByLabelText('Modèle')).toBeDisabled();

    fireEvent.change(provider, { target: { value: 'openrouter' } });
    const model = screen.getByLabelText('Modèle');
    expect(model).toBeEnabled();
    expect(
      within(model)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Par défaut (anthropic/claude-haiku-5.5)',
      'anthropic/claude-haiku-5.5',
      'mistralai/mistral-small-2603',
    ]);
    fireEvent.change(model, { target: { value: 'mistralai/mistral-small-2603' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer l’IA' }));

    expect(await screen.findByText('Préférence IA enregistrée.')).toBeInTheDocument();
    expect(lastPatch(fetchSpy)).toEqual({
      ai_provider: 'openrouter',
      ai_model: 'mistralai/mistral-small-2603',
    });
  });

  it('shows a provider without server key as unavailable', async () => {
    fakeAuth.signIn();
    mockApi(); // Gemini configured, OpenRouter without key
    renderApp('/settings');
    const option = await screen.findByRole('option', { name: /OpenRouter — clé absente/ });
    expect(option).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Google Gemini' })).toBeEnabled();
  });

  it('switching provider resets the model, and "default" sends nulls', async () => {
    fakeAuth.signIn();
    const fetchSpy = mockApi({
      'GET /me': () =>
        json({
          ...ME,
          preferences: { ai_provider: 'gemini', ai_model: AI_CONFIG.providers[0]!.models[2] },
        }),
      'GET /ai/config': () => json(AI_CONFIG_BOTH),
      'PATCH /me/preferences': () => json({}),
    });
    renderApp('/settings');
    await waitFor(() =>
      expect(screen.getByLabelText('Modèle')).toHaveValue('gemini-3.5-flash-lite'),
    );
    fireEvent.change(screen.getByLabelText('Fournisseur'), { target: { value: '' } });
    expect(screen.getByLabelText('Modèle')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer l’IA' }));
    await screen.findByText('Préférence IA enregistrée.');
    expect(lastPatch(fetchSpy)).toEqual({ ai_provider: null, ai_model: null });
  });
});
