import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { json, mockApi, renderApp } from './test/render';
import { fakeAuth } from './test/fakeSupabase';
import { addDays, fromLocalInput, startOfWeek, toLocalInput } from './lib/dates';

const task = (id: string, title: string, extra = {}) => ({
  id,
  workspace_id: 'ws-1',
  project_id: null,
  title,
  notes: null,
  status: 'todo',
  priority: 'normal',
  due_at: null,
  completed_at: null,
  created_at: '2026-11-14T10:00:00Z',
  updated_at: '2026-11-14T10:00:00Z',
  ...extra,
});
const callsTo = (spy: ReturnType<typeof mockApi>, method: string, path: string) =>
  spy.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && new URL(String(url)).pathname === path,
  );

describe('date helpers', () => {
  it('round-trips datetime-local values and finds Monday', () => {
    const iso = fromLocalInput('2026-11-20T14:30')!;
    expect(toLocalInput(iso)).toBe('2026-11-20T14:30');
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('n’importe quoi')).toBeNull();
    const monday = startOfWeek(new Date(2026, 10, 15)); // Sunday 15 Nov 2026
    expect([monday.getDate(), monday.getDay()]).toEqual([9, 1]);
    expect(addDays(monday, 7).getDate()).toBe(16);
  });
});

describe('tasks', () => {
  it('adds a task with priority, due date and project', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /projects': () =>
        json([
          {
            id: 'p1',
            workspace_id: 'ws-1',
            name: 'Déménagement',
            description: null,
            status: 'active',
            created_at: '',
            updated_at: '',
          },
        ]),
      'POST /tasks': () => json(task('t1', 'Résilier le bail'), 201),
    });
    renderApp('/tasks');
    const form = await screen.findByRole('form', { name: 'Ajouter une tâche' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Déménagement' })).toBeInTheDocument(),
    );
    fireEvent.change(within(form).getByLabelText('Nouvelle tâche'), {
      target: { value: ' Résilier le bail ' },
    });
    fireEvent.change(within(form).getByLabelText('Priorité'), { target: { value: 'urgent' } });
    fireEvent.change(within(form).getByLabelText('Échéance'), {
      target: { value: '2026-11-20T09:00' },
    });
    fireEvent.change(within(form).getByLabelText('Projet'), { target: { value: 'p1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Ajouter' }));
    await waitFor(() => expect(callsTo(spy, 'POST', '/tasks')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'POST', '/tasks')[0]![1]!.body))).toEqual({
      title: 'Résilier le bail',
      priority: 'urgent',
      due_at: fromLocalInput('2026-11-20T09:00'),
      project_id: 'p1',
    });
  });

  it('flags overdue tasks and completes one optimistically', async () => {
    fakeAuth.signIn();
    let resolve!: (r: Response) => void;
    const spy = mockApi({
      'GET /tasks': () =>
        json([task('t1', 'Payer le loyer', { priority: 'high', due_at: '2020-01-01T09:00:00Z' })]),
      'PATCH /tasks/t1': () => new Promise<Response>((r) => (resolve = r)),
    });
    renderApp('/tasks');
    const list = await screen.findByRole('region', { name: 'Liste des tâches' });
    expect(await within(list).findByText(/En retard/)).toBeInTheDocument();
    expect(within(list).getByText('Haute')).toBeInTheDocument();
    const box = within(list).getByRole('checkbox', { name: 'Terminer « Payer le loyer »' });
    fireEvent.click(box);
    expect(box).toBeChecked(); // before the server answered
    await waitFor(() => expect(callsTo(spy, 'PATCH', '/tasks/t1')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(spy, 'PATCH', '/tasks/t1')[0]![1]!.body))).toEqual({
      status: 'done',
    });
    resolve(new Response(JSON.stringify(task('t1', 'Payer le loyer', { status: 'done' }))));
  });

  it('deletes a task only after confirmation', async () => {
    fakeAuth.signIn();
    const spy = mockApi({
      'GET /tasks': () => json([task('t1', 'À supprimer')]),
      'DELETE /tasks/t1': () => Promise.resolve(new Response(null, { status: 204 })),
    });
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderApp('/tasks');
    const remove = await screen.findByRole('button', { name: 'Supprimer « À supprimer »' });
    fireEvent.click(remove);
    expect(callsTo(spy, 'DELETE', '/tasks/t1')).toHaveLength(0);
    fireEvent.click(remove);
    await waitFor(() => expect(callsTo(spy, 'DELETE', '/tasks/t1')).toHaveLength(1));
  });
});

describe('documents and calendar', () => {
  it('searches documents and shows highlighted snippets as plain text', async () => {
    fakeAuth.signIn();
    mockApi({
      'GET /documents': () =>
        json([
          {
            id: 'd1',
            project_id: null,
            title: 'Inventaire',
            snippet: 'la «vaisselle» <b>fragile</b>',
            updated_at: '2026-11-14T10:00:00Z',
          },
        ]),
    });
    renderApp('/documents');
    expect(await screen.findByText('la «vaisselle» <b>fragile</b>')).toBeInTheDocument();
  });

  it('refuses an event that ends before it starts', async () => {
    fakeAuth.signIn();
    mockApi();
    renderApp('/calendar');
    const form = await screen.findByRole('form', { name: 'Nouvel événement' });
    fireEvent.change(within(form).getByLabelText('Titre'), { target: { value: 'Réunion' } });
    fireEvent.change(within(form).getByLabelText('Début'), {
      target: { value: '2026-11-20T10:00' },
    });
    fireEvent.change(within(form).getByLabelText('Fin'), { target: { value: '2026-11-20T09:00' } });
    expect(within(form).getByText('La fin doit suivre le début.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Ajouter à l’agenda' })).toBeDisabled();
  });
});
