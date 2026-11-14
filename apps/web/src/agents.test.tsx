import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { json, mockApi, renderApp } from './test/render';
import { fakeAuth } from './test/fakeSupabase';

const TOOLS = [
  { name: 'clock.now', risk: 'read', description: 'Date et heure', input: {} },
  { name: 'memory.remember', risk: 'write', description: 'Retenir', input: {} },
];
const agent = (extra = {}) => ({
  id: 'ag1',
  name: 'Chercheur',
  description: null,
  instructions: '',
  tools: ['clock.now'],
  auto_write: false,
  provider: null,
  model: null,
  created_at: '2026-11-14T10:00:00Z',
  updated_at: '2026-11-14T10:00:00Z',
  ...extra,
});
const M1 = '33333333-3333-4333-8333-333333333333';
const callsTo = (spy: ReturnType<typeof mockApi>, method: string, path: string) =>
  spy.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && new URL(String(url)).pathname === path,
  );

describe('Agent Studio', () => {
  it('creates an agent with chosen tools; auto_write only makes sense with a write tool', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /tools': () => json(TOOLS),
      'POST /agents': () => json(agent(), 201),
    });
    renderApp('/agents');
    const form = await screen.findByRole('form', { name: 'Créer un agent' });
    expect(await screen.findByText(/Aucun agent/)).toBeInTheDocument();
    const auto = within(form).getByRole('checkbox', { name: /Écrire sans demander/ });
    expect(auto).toBeDisabled();

    fireEvent.change(within(form).getByLabelText('Nom'), { target: { value: ' Scribe ' } });
    fireEvent.change(within(form).getByLabelText('Consignes'), {
      target: { value: 'Note ce qui compte.' },
    });
    fireEvent.click(within(form).getByRole('checkbox', { name: /memory\.remember/ }));
    expect(auto).toBeEnabled();
    expect(within(form).getByText('Écriture')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Créer l’agent' }));

    await waitFor(() => expect(callsTo(spy, 'POST', '/agents')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'POST', '/agents')[0]![1]!.body))).toEqual({
      name: 'Scribe',
      description: null,
      instructions: 'Note ce qui compte.',
      tools: ['memory.remember'],
      auto_write: false,
    });
  });

  it('lists agents with their write policy, edits and deletes after confirmation', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /tools': () => json(TOOLS),
      'GET /agents': () =>
        json([agent({ tools: ['clock.now', 'memory.remember'], auto_write: true })]),
      'PATCH /agents/ag1': () => json(agent()),
      'DELETE /agents/ag1': () => Promise.resolve(new Response(null, { status: 204 })),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/agents');
    const list = await screen.findByRole('region', { name: 'Mes agents' });
    expect(
      await within(list).findByText('Écrit sans demander votre validation.'),
    ).toBeInTheDocument();
    expect(within(list).getByText('Outils : clock.now, memory.remember')).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: 'Modifier Chercheur' }));
    const edit = within(list).getByRole('form', { name: 'Modifier Chercheur' });
    fireEvent.click(within(edit).getByRole('checkbox', { name: /memory\.remember/ }));
    fireEvent.click(within(edit).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(callsTo(spy, 'PATCH', '/agents/ag1')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'PATCH', '/agents/ag1')[0]![1]!.body)).tools).toEqual([
      'clock.now',
    ]);

    fireEvent.click(await within(list).findByRole('button', { name: 'Supprimer Chercheur' }));
    await waitFor(() => expect(callsTo(spy, 'DELETE', '/agents/ag1')).toHaveLength(1));
  });

  it('runs a mission with an agent, and shows its tool calls and tool approvals', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /agents': () => json([agent()]),
      'POST /missions': () => json({ id: M1 }, 201),
      [`GET /missions/${M1}`]: () =>
        json({
          id: M1,
          title: 'Mission outillée',
          goal: 'But',
          status: 'awaiting_approval',
          provider: null,
          model: null,
          agent_id: 'ag1',
          result: null,
          error_code: null,
          created_at: '2026-11-14T10:00:00Z',
          updated_at: '2026-11-14T10:00:00Z',
          finished_at: null,
          agent: { id: 'ag1', name: 'Chercheur' },
          steps: [
            {
              id: 's1',
              position: 1,
              title: 'Chercher',
              instruction: 'Avec les outils',
              requires_approval: false,
              status: 'pending',
              attempt: 1,
              failures: 0,
              output: null,
              error_code: null,
              started_at: null,
              finished_at: null,
            },
          ],
          approvals: [
            {
              id: 'ap1',
              mission_id: M1,
              step_id: 's1',
              tool_call_id: 'c2',
              kind: 'tool',
              summary: 'Chercheur veut : Retenir : « Parle italien »',
              status: 'pending',
              decided_at: null,
              created_at: '2026-11-14T10:00:00Z',
            },
          ],
          tool_calls: [
            {
              id: 'c1',
              step_id: 's1',
              tool: 'memory.forget',
              input: {},
              status: 'denied',
              output: null,
              error: 'not_allowed',
              created_at: '',
              finished_at: '',
            },
            {
              id: 'c2',
              step_id: 's1',
              tool: 'memory.remember',
              input: {},
              status: 'pending_approval',
              output: null,
              error: null,
              created_at: '',
              finished_at: null,
            },
          ],
        }),
    });
    const router = renderApp('/missions');
    const select = await screen.findByLabelText('Agent');
    await waitFor(() =>
      expect(
        within(select).getByRole('option', { name: 'Chercheur (1 outil)' }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(select, { target: { value: 'ag1' } });
    fireEvent.change(screen.getByLabelText('Nouvelle mission'), { target: { value: 'But' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lancer' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/missions/${M1}`));
    expect(JSON.parse(String(callsTo(spy, 'POST', '/missions')[0]![1]!.body))).toEqual({
      goal: 'But',
      agent_id: 'ag1',
    });

    const card = await screen.findByRole('region', { name: 'Validation requise' });
    expect(within(card).getByText('Autoriser cet outil')).toBeInTheDocument();
    expect(within(card).getByText(/la mission continue sans elle/)).toBeInTheDocument();
    const calls = screen.getByRole('list', { name: 'Appels d’outils' });
    expect(within(calls).getByText('refusé (non autorisé)')).toBeInTheDocument();
    expect(within(calls).getByText('attend votre accord')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chercheur' })).toHaveAttribute('href', '/agents');
  });
});
