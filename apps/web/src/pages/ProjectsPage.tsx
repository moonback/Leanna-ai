import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, FolderKanban, Trash2 } from 'lucide-react';
import {
  createProject,
  deleteProject,
  fetchProjects,
  fetchTasks,
  updateProject,
  type Project,
} from '@/lib/api';
import { FormError, Input } from '@/components/Form';
import { cn } from '@/lib/utils';
import { errorMessage } from './TasksPage';

function ProjectItem({ project, openTasks }: { project: Project; openTasks: number }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['projects'] });
  const archive = useMutation({
    mutationFn: () =>
      updateProject(project.id, { status: project.status === 'active' ? 'archived' : 'active' }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () =>
      Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['tasks'] })]),
  });
  const archived = project.status === 'archived';

  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <FolderKanban
          className={cn('mt-0.5 size-5 shrink-0', archived ? 'text-ink-faint' : 'text-cyan')}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className={cn('text-sm font-medium', archived && 'text-ink-muted')}>
            {project.name}
            {archived && <span className="ml-2 text-xs font-normal text-ink-faint">archivé</span>}
          </h3>
          {project.description && <p className="text-xs text-ink-muted">{project.description}</p>}
          <Link
            to={`/tasks?project=${project.id}`}
            className="mt-1 inline-block text-xs text-cyan hover:underline"
          >
            {openTasks} tâche{openTasks > 1 ? 's' : ''} ouverte{openTasks > 1 ? 's' : ''}
          </Link>
        </div>
        <button
          type="button"
          aria-label={`${archived ? 'Désarchiver' : 'Archiver'} ${project.name}`}
          onClick={() => archive.mutate()}
          className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
        >
          {archived ? (
            <ArchiveRestore className="size-4" aria-hidden />
          ) : (
            <Archive className="size-4" aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label={`Supprimer ${project.name}`}
          onClick={() => {
            if (
              window.confirm(
                `Supprimer le projet « ${project.name} » ? Ses tâches et documents sont conservés, sans projet.`,
              )
            ) {
              remove.mutate();
            }
          }}
          className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-danger"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      <FormError
        message={archive.error || remove.error ? errorMessage(archive.error ?? remove.error) : null}
      />
    </li>
  );
}

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const projects = useQuery({
    queryKey: ['projects', showArchived ? 'all' : 'active'],
    queryFn: ({ signal }) => fetchProjects(showArchived ? 'all' : 'active', signal),
  });
  const open = useQuery({
    queryKey: ['tasks', 'open', ''],
    queryFn: ({ signal }) => fetchTasks({ status: 'open' }, signal),
  });
  const create = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      setName('');
      setDescription('');
      return queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) {
      create.mutate({ name: name.trim(), description: description.trim() || null });
    }
  }
  const count = (id: string) => open.data?.filter((t) => t.project_id === id).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
        <FolderKanban className="size-6 text-cyan" aria-hidden /> Projets
      </h1>
      <form onSubmit={onSubmit} aria-label="Nouveau projet" className="glass space-y-2 p-4">
        <label htmlFor="project-name" className="sr-only">
          Nom du projet
        </label>
        <Input
          id="project-name"
          value={name}
          maxLength={120}
          placeholder="Nom du projet"
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="project-description" className="sr-only">
          Description du projet
        </label>
        <Input
          id="project-description"
          value={description}
          maxLength={2000}
          placeholder="Description (facultative)"
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          type="submit"
          disabled={!name.trim() || create.isPending}
          className="rounded-lg bg-gradient-to-r from-cyan to-electric px-4 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          Créer le projet
        </button>
        <FormError message={create.error ? errorMessage(create.error) : null} />
      </form>

      <section className="glass p-4" aria-label="Liste des projets">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="size-4 accent-cyan"
          />
          Afficher les projets archivés
        </label>
        {projects.isPending && <p className="mt-3 text-sm text-ink-muted">Chargement…</p>}
        {projects.isError && <FormError message={errorMessage(projects.error)} />}
        {projects.data?.length === 0 && (
          <p className="mt-3 text-sm text-ink-muted">Aucun projet.</p>
        )}
        <ul className="divide-y divide-white/5">
          {projects.data?.map((p) => (
            <ProjectItem key={p.id} project={p} openTasks={count(p.id)} />
          ))}
        </ul>
      </section>
    </div>
  );
}
