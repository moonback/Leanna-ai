import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Pencil, Trash2 } from 'lucide-react';
import {
  ApiError,
  createTask,
  deleteTask,
  fetchProjects,
  fetchTasks,
  updateTask,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '@/lib/api';
import { dateTime, fromLocalInput, toLocalInput } from '@/lib/dates';
import { Field, FormError, Input, Select } from '@/components/Form';
import { cn } from '@/lib/utils';

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: 'Urgente',
  high: 'Haute',
  normal: 'Normale',
  low: 'Basse',
};
const PRIORITY_STYLES: Record<TaskPriority, string> = {
  urgent: 'border-danger/40 text-danger',
  high: 'border-warning/40 text-warning',
  normal: 'border-white/10 text-ink-muted',
  low: 'border-white/10 text-ink-faint',
};
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'À faire',
  in_progress: 'En cours',
  done: 'Terminée',
};
const FILTERS = [
  ['open', 'Ouvertes'],
  ['in_progress', 'En cours'],
  ['done', 'Terminées'],
  ['all', 'Toutes'],
] as const;

export function errorMessage(err: unknown) {
  if (err instanceof ApiError) return err.message;
  return 'Le serveur est injoignable.';
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded border px-1.5 text-[10px] uppercase tracking-wide',
        PRIORITY_STYLES[priority],
      )}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

function useInvalidateTasks() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['tasks'] });
}

function QuickAdd({ projects, projectId }: { projects: Project[]; projectId: string }) {
  const refresh = useInvalidateTasks();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [due, setDue] = useState('');
  const [project, setProject] = useState(projectId);
  const mutation = useMutation({
    mutationFn: createTask,
    // Clear the field only if it still holds what was sent: text typed meanwhile stays.
    onSuccess: (_, sent) => {
      setTitle((t) => (t.trim() === sent.title ? '' : t));
      setDue('');
      setPriority('normal'); // the project stays: handy to enter several tasks for it
      return refresh();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    mutation.mutate({
      title: title.trim(),
      priority,
      due_at: fromLocalInput(due),
      project_id: project || null,
    });
  }

  return (
    <form onSubmit={onSubmit} aria-label="Ajouter une tâche" className="glass space-y-3 p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="task-title" className="sr-only">
          Nouvelle tâche
        </label>
        <Input
          id="task-title"
          value={title}
          maxLength={200}
          placeholder="Nouvelle tâche…"
          onChange={(e) => {
            setTitle(e.target.value);
            mutation.reset();
          }}
        />
        <button
          type="submit"
          disabled={!title.trim() || mutation.isPending}
          className="shrink-0 rounded-lg bg-gradient-to-r from-cyan to-electric px-4 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          Ajouter
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field id="task-priority" label="Priorité">
          <Select
            id="task-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
          >
            {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="task-due" label="Échéance">
          <Input
            id="task-due"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </Field>
        <Field id="task-project" label="Projet">
          <Select id="task-project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Aucun</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
    </form>
  );
}

function TaskEditor({
  task,
  projects,
  onDone,
}: {
  task: Task;
  projects: Project[];
  onDone: () => void;
}) {
  const refresh = useInvalidateTasks();
  const [draft, setDraft] = useState({
    title: task.title,
    notes: task.notes ?? '',
    status: task.status,
    priority: task.priority,
    due: toLocalInput(task.due_at),
    project: task.project_id ?? '',
  });
  const mutation = useMutation({
    mutationFn: () =>
      updateTask(task.id, {
        title: draft.title.trim(),
        notes: draft.notes,
        status: draft.status,
        priority: draft.priority,
        due_at: fromLocalInput(draft.due),
        project_id: draft.project || null,
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const id = (f: string) => `task-${task.id}-${f}`;

  return (
    <form
      aria-label={`Modifier « ${task.title} »`}
      className="space-y-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.title.trim()) mutation.mutate();
      }}
    >
      <Field id={id('title')} label="Titre">
        <Input
          id={id('title')}
          value={draft.title}
          maxLength={200}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>
      <Field id={id('notes')} label="Notes">
        <textarea
          id={id('notes')}
          value={draft.notes}
          maxLength={4000}
          rows={2}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          className="w-full resize-y rounded-lg border border-white/10 bg-night-950/60 px-3 py-2 text-sm text-ink focus:border-cyan/60 focus:outline-none"
        />
      </Field>
      <div className="grid gap-2 sm:grid-cols-4">
        <Field id={id('status')} label="Statut">
          <Select
            id={id('status')}
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as TaskStatus })}
          >
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id('priority')} label="Priorité">
          <Select
            id={id('priority')}
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value as TaskPriority })}
          >
            {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id('due')} label="Échéance">
          <Input
            id={id('due')}
            type="datetime-local"
            value={draft.due}
            onChange={(e) => setDraft({ ...draft, due: e.target.value })}
          />
        </Field>
        <Field id={id('project')} label="Projet">
          <Select
            id={id('project')}
            value={draft.project}
            onChange={(e) => setDraft({ ...draft, project: e.target.value })}
          >
            <option value="">Aucun</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!draft.title.trim() || mutation.isPending}
          className="rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-1.5 text-sm text-cyan disabled:opacity-40"
        >
          Enregistrer
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-3 py-1.5 text-sm text-ink-muted hover:bg-white/5"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}

function TaskItem({ task, projects }: { task: Task; projects: Project[] }) {
  const refresh = useInvalidateTasks();
  const [editing, setEditing] = useState(false);
  // Optimistic: the box follows the click at once, the server answer then takes over.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const toggle = useMutation({
    mutationFn: (done: boolean) => updateTask(task.id, { status: done ? 'done' : 'todo' }),
    onSettled: async () => {
      await refresh();
      setOptimistic(null);
    },
  });
  const remove = useMutation({ mutationFn: () => deleteTask(task.id), onSuccess: refresh });
  const done = optimistic ?? task.status === 'done';
  const overdue = !done && task.due_at && new Date(task.due_at) < new Date();
  const project = projects.find((p) => p.id === task.project_id);

  if (editing) {
    return (
      <li>
        <TaskEditor task={task} projects={projects} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={done}
          disabled={toggle.isPending}
          onChange={(e) => {
            setOptimistic(e.target.checked);
            toggle.mutate(e.target.checked);
          }}
          aria-label={`${done ? 'Rouvrir' : 'Terminer'} « ${task.title} »`}
          className="mt-0.5 size-4 shrink-0 accent-cyan"
        />
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm break-words', done && 'text-ink-faint line-through')}>
            {task.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <PriorityBadge priority={task.priority} />
            {task.status === 'in_progress' && <span className="text-cyan">En cours</span>}
            {task.due_at && (
              <span className={cn(overdue && 'text-danger')}>
                {overdue ? 'En retard · ' : 'Échéance · '}
                {dateTime.format(new Date(task.due_at))}
              </span>
            )}
            {project && <span>· {project.name}</span>}
          </p>
          {task.notes && <p className="mt-1 text-xs text-ink-muted">{task.notes}</p>}
        </div>
        <button
          type="button"
          aria-label={`Modifier « ${task.title} »`}
          onClick={() => setEditing(true)}
          className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
        >
          <Pencil className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Supprimer « ${task.title} »`}
          onClick={() => {
            if (window.confirm(`Supprimer la tâche « ${task.title} » ?`)) remove.mutate();
          }}
          className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-danger"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      <FormError
        message={toggle.error || remove.error ? errorMessage(toggle.error ?? remove.error) : null}
      />
    </li>
  );
}

export function TasksPage() {
  // Local state, seeded from the URL (/tasks?project=… links from Projects). React Router's
  // setSearchParams does not queue updates, so two quick filter changes would collide.
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? 'open');
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: ({ signal }) => fetchProjects('all', signal),
  });
  const tasks = useQuery({
    queryKey: ['tasks', status, projectId],
    queryFn: ({ signal }) => fetchTasks({ status, project_id: projectId || undefined }, signal),
  });
  const list = projects.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
        <CheckSquare className="size-6 text-cyan" aria-hidden /> Tâches
      </h1>
      <QuickAdd
        key={projectId}
        projects={list.filter((p) => p.status === 'active')}
        projectId={projectId}
      />

      <section className="glass p-4" aria-label="Liste des tâches">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div role="tablist" aria-label="Statut" className="flex flex-wrap gap-1">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={status === value}
                onClick={() => setStatus(value)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm',
                  status === value ? 'bg-white/8 text-ink' : 'text-ink-muted hover:bg-white/5',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="sm:w-56">
            <label htmlFor="task-filter-project" className="sr-only">
              Filtrer par projet
            </label>
            <Select
              id="task-filter-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Tous les projets</option>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {tasks.isPending && <p className="mt-4 text-sm text-ink-muted">Chargement…</p>}
        {tasks.isError && <FormError message={errorMessage(tasks.error)} />}
        {tasks.data?.length === 0 && (
          <p className="mt-4 text-sm text-ink-muted">Aucune tâche ici.</p>
        )}
        <ul className="mt-2 divide-y divide-white/5">
          {tasks.data?.map((t) => (
            <TaskItem key={t.id} task={t} projects={list} />
          ))}
        </ul>
      </section>
    </div>
  );
}
