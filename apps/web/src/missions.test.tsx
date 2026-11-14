import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { json, mockApi, renderApp } from './test/render';
import { fakeAuth } from './test/fakeSupabase';

const M1 = '22222222-2222-4222-8222-222222222222';
const mission = (extra = {}) => ({
  id: M1,
  title: 'Week-end à Rome',
  goal: 'Organiser un week-end à Rome',
  status: 'awaiting_approval',
  provider: 'gemini',
  model: 'gemini-3.6-flash',
  result: null,
  error_code: null,
  created_at: '2026-11-14T10:00:00Z',
  updated_at: '2026-11-14T10:00:00Z',
  finished_at: null,
  agent_id: null,
  agent: null,
  tool_calls: [],
  ...extra,
});
const step = (position: number, title: string, extra = {}) => ({
  id: `s${position}`,
  position,
  title,
  instruction: `Faire : ${title}`,
  requires_approval: false,
  status: 'pending',
  attempt: 0,
  output: null,
  error_code: null,
  started_at: null,
  finished_at: null,
  ...extra,
});
const approval = (extra = {}) => ({
  id: 'a1',
  mission_id: M1,
  step_id: null,
  kind: 'plan',
  summary: 'Plan de 2 étapes pour « Week-end à Rome »',
  status: 'pending',
  decided_at: null,
  created_at: '2026-11-14T10:00:00Z',
  ...extra,
});
const callsTo = (spy: ReturnType<typeof mockApi>, method: string, path: string) =>
  spy.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && new URL(String(url)).pathname === path,
  );

describe('missions', () => {
  it('launches a mission from a goal and opens it', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'POST /missions': () => json(mission({ status: 'planning' }), 201),
      [`GET /missions/${M1}`]: () =>
        json({ ...mission({ status: 'planning' }), steps: [], approvals: [] }),
    });
    const router = renderApp('/missions');
    expect(await screen.findByText('Aucune mission pour l’instant.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Nouvelle mission'), {
      target: { value: '  Organiser un week-end à Rome ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lancer' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/missions/${M1}`));
    expect(await screen.findByText('LEANA prépare un plan…')).toBeInTheDocument();
    expect(JSON.parse(String(callsTo(spy, 'POST', '/missions')[0]![1]!.body))).toEqual({
      goal: 'Organiser un week-end à Rome',
      agent_id: null,
    });
  });

  it('says when missions are not configured', async () => {
    fakeAuth.signIn();
    mockApi({ 'GET /missions/config': () => json({ configured: false }) });
    renderApp('/missions');
    expect(await screen.findByText(/ne sont pas configurées sur ce serveur/)).toBeInTheDocument();
    expect(screen.getByLabelText('Nouvelle mission')).toBeDisabled();
  });

  it('shows the plan and asks for its approval; approving sends the decision', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      [`GET /missions/${M1}`]: () =>
        json({
          ...mission(),
          steps: [
            step(1, 'Chercher des vols'),
            step(2, 'Rédiger l’e-mail', { requires_approval: true }),
          ],
          approvals: [approval()],
        }),
      'POST /approvals/a1/decide': () => json(approval({ status: 'approved' })),
    });
    renderApp(`/missions/${M1}`);
    const card = await screen.findByRole('region', { name: 'Validation requise' });
    expect(within(card).getByText('Valider le plan')).toBeInTheDocument();
    const plan = screen.getByRole('region', { name: 'Plan' });
    expect(within(plan).getByText('1. Chercher des vols')).toBeInTheDocument();
    expect(within(plan).getByText('validation requise')).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Approuver' }));
    await waitFor(() => expect(callsTo(spy, 'POST', '/approvals/a1/decide')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'POST', '/approvals/a1/decide')[0]![1]!.body))).toEqual({
      decision: 'approved',
    });
  });

  it('shows results, retries and the final result of a completed mission', async () => {
    fakeAuth.signIn();
    mockApi({
      [`GET /missions/${M1}`]: () =>
        json({
          ...mission({ status: 'completed', result: 'Programme complet' }),
          steps: [step(1, 'Chercher', { status: 'done', attempt: 2, output: 'Trois vols' })],
          approvals: [approval({ status: 'approved' })],
        }),
    });
    renderApp(`/missions/${M1}`);
    expect(await screen.findByText('Terminée')).toBeInTheDocument();
    expect(screen.getByText('tentative 2')).toBeInTheDocument();
    expect(screen.getByText('Trois vols')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Résultat' })).getByText('Programme complet'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Arrêter la mission')).not.toBeInTheDocument();
  });

  it('explains a failure', async () => {
    fakeAuth.signIn();
    mockApi({
      [`GET /missions/${M1}`]: () =>
        json({
          ...mission({ status: 'failed', error_code: 'invalid_plan' }),
          steps: [],
          approvals: [],
        }),
    });
    renderApp(`/missions/${M1}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(/plan exploitable/);
  });

  it('stops a mission only after confirmation', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      [`GET /missions/${M1}`]: () =>
        json({
          ...mission({ status: 'running' }),
          steps: [step(1, 'X', { status: 'running', attempt: 1 })],
          approvals: [],
        }),
      [`POST /missions/${M1}/cancel`]: () => json(mission({ status: 'cancelled' })),
    });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderApp(`/missions/${M1}`);
    const stop = await screen.findByRole('button', { name: 'Arrêter la mission' });
    fireEvent.click(stop);
    expect(callsTo(spy, 'POST', `/missions/${M1}/cancel`)).toHaveLength(0);
    fireEvent.click(stop);
    await waitFor(() => expect(callsTo(spy, 'POST', `/missions/${M1}/cancel`)).toHaveLength(1));
  });
});

describe('activity and notifications', () => {
  it('shows the unread count in the sidebar and opens a notification', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /notifications': () =>
        json({
          items: [
            {
              id: 'n1',
              title: 'Validation demandée : Plan de 2 étapes',
              link: `/missions/${M1}`,
              read_at: null,
              created_at: '2026-11-14T10:00:00Z',
            },
          ],
          unread: 1,
        }),
      'POST /notifications/read': () => json({ marked: 1 }),
      [`GET /missions/${M1}`]: () => json({ ...mission(), steps: [], approvals: [] }),
    });
    const router = renderApp('/notifications');
    const nav = await screen.findByRole('navigation', { name: 'Navigation principale' });
    expect(
      await within(nav).findByRole('link', { name: /Notifications\s*\(1 non lue\)/ }),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Validation demandée/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/missions/${M1}`));
    expect(JSON.parse(String(callsTo(spy, 'POST', '/notifications/read')[0]![1]!.body))).toEqual({
      ids: ['n1'],
    });
  });

  it('lists the activity log with links to missions', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /activity': () =>
        json([
          {
            id: 'e1',
            mission_id: M1,
            kind: 'step.retried',
            summary: 'Étape 1 reprise (tentative 2) : Chercher',
            created_at: '2026-11-14T10:00:00Z',
          },
        ]),
    });
    renderApp('/activity');
    expect(
      await screen.findByRole('link', { name: 'Étape 1 reprise (tentative 2) : Chercher' }),
    ).toHaveAttribute('href', `/missions/${M1}`);
  });

  it('puts pending approvals and recent activity on the dashboard', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /missions': () => json([mission()]),
      'GET /approvals': () => json([{ ...approval(), mission: { title: 'Week-end à Rome' } }]),
      'GET /activity': () =>
        json([
          {
            id: 'e1',
            mission_id: M1,
            kind: 'mission.created',
            summary: 'Mission créée : Rome',
            created_at: '2026-11-14T10:00:00Z',
          },
        ]),
    });
    renderApp('/');
    expect(await screen.findByRole('link', { name: /1 validation en attente/ })).toHaveAttribute(
      'href',
      `/missions/${M1}`,
    );
    expect(await screen.findByText('Mission créée : Rome')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Missions en cours' });
    expect(within(panel).getByText('Week-end à Rome')).toBeInTheDocument();
  });
});
