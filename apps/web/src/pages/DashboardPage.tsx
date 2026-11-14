import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity, Calendar, CheckSquare, Rocket, ShieldCheck } from 'lucide-react';
import {
  fetchActivity,
  fetchEvents,
  fetchMissions,
  fetchPendingApprovals,
  fetchTasks,
} from '@/lib/api';
import { addDays, dateTime, dayLabel, timeLabel } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { PriorityBadge } from './TasksPage';
import { useMe } from '@/lib/useMe';
import { StatusBadge } from './MissionsPage';

const ACTIVE = ['planning', 'awaiting_approval', 'running'];

function Panel({
  icon: Icon,
  title,
  link,
  children,
}: {
  icon: typeof Rocket;
  title: string;
  link: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="glass flex flex-col p-5" aria-label={title}>
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
        <Icon className="size-4 text-cyan" aria-hidden />
        {title}
        <Link to={link.to} className="ml-auto text-xs font-normal text-cyan hover:underline">
          {link.label}
        </Link>
      </h2>
      <div className="mt-4 text-sm">{children}</div>
    </section>
  );
}

function MissionsPanel() {
  const missions = useQuery({
    queryKey: ['missions'],
    queryFn: ({ signal }) => fetchMissions(signal),
  });
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: ({ signal }) => fetchPendingApprovals(signal),
  });
  const active = missions.data?.filter((m) => ACTIVE.includes(m.status)) ?? [];
  const pending = approvals.data?.length ?? 0;
  return (
    <Panel icon={Rocket} title="Missions en cours" link={{ to: '/missions', label: 'Toutes' }}>
      {pending > 0 && (
        <Link
          to={`/missions/${approvals.data![0]!.mission_id}`}
          className="mb-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning"
        >
          <ShieldCheck className="size-4" aria-hidden />
          {pending} validation{pending > 1 ? 's' : ''} en attente
        </Link>
      )}
      {missions.isPending && <p className="text-ink-muted">Chargement…</p>}
      {missions.isError && <p className="text-ink-muted">Missions indisponibles.</p>}
      {missions.data && active.length === 0 && (
        <p className="text-ink-muted">Aucune mission en cours.</p>
      )}
      <ul className="space-y-1">
        {active.slice(0, 5).map((m) => (
          <li key={m.id}>
            <Link to={`/missions/${m.id}`} className="flex items-center gap-2 hover:text-cyan">
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              <StatusBadge status={m.status} />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ActivityPanel() {
  const activity = useQuery({
    queryKey: ['activity', 5],
    queryFn: ({ signal }) => fetchActivity(5, signal),
  });
  return (
    <Panel icon={Activity} title="Activité récente" link={{ to: '/activity', label: 'Journal' }}>
      {activity.isPending && <p className="text-ink-muted">Chargement…</p>}
      {activity.isError && <p className="text-ink-muted">Journal indisponible.</p>}
      {activity.data?.length === 0 && (
        <p className="text-ink-muted">Aucune activité enregistrée.</p>
      )}
      <ul className="space-y-1.5">
        {activity.data?.map((a) => (
          <li key={a.id} className="truncate text-ink-muted">
            {a.summary}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function TasksPanel() {
  const tasks = useQuery({
    queryKey: ['tasks', 'open', ''],
    queryFn: ({ signal }) => fetchTasks({ status: 'open' }, signal),
  });
  const now = new Date();
  return (
    <Panel icon={CheckSquare} title="Tâches prioritaires" link={{ to: '/tasks', label: 'Toutes' }}>
      {tasks.isPending && <p className="text-ink-muted">Chargement…</p>}
      {tasks.isError && <p className="text-ink-muted">Tâches indisponibles.</p>}
      {tasks.data?.length === 0 && <p className="text-ink-muted">Aucune tâche ouverte.</p>}
      <ul className="space-y-1.5">
        {tasks.data?.slice(0, 5).map((t) => {
          const late = t.due_at && new Date(t.due_at) < now;
          return (
            <li key={t.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.due_at && (
                <span className={cn('shrink-0 text-xs', late ? 'text-danger' : 'text-ink-faint')}>
                  {dateTime.format(new Date(t.due_at))}
                </span>
              )}
              <PriorityBadge priority={t.priority} />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function AgendaPanel() {
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const events = useQuery({
    queryKey: ['events', 'upcoming'],
    queryFn: ({ signal }) =>
      fetchEvents({ from: new Date().toISOString(), to: addDays(today, 7).toISOString() }, signal),
  });
  return (
    <Panel icon={Calendar} title="Agenda" link={{ to: '/calendar', label: 'Calendrier' }}>
      {events.isPending && <p className="text-ink-muted">Chargement…</p>}
      {events.isError && <p className="text-ink-muted">Agenda indisponible.</p>}
      {events.data?.length === 0 && (
        <p className="text-ink-muted">Aucun événement dans les 7 prochains jours.</p>
      )}
      <ul className="space-y-1.5">
        {events.data?.slice(0, 5).map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-36 shrink-0 text-xs capitalize text-cyan">
              {dayLabel.format(new Date(e.starts_at))}
              {!e.all_day && ` ${timeLabel.format(new Date(e.starts_at))}`}
            </span>
            <span className="min-w-0 truncate">{e.title}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// Only real data, never placeholders.
export function DashboardPage() {
  const name = useMe().data?.profile.display_name;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="glass relative overflow-hidden p-6 md:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-violet/20 blur-3xl"
        />
        <p className="text-xs uppercase tracking-[0.2em] text-cyan">Tableau de bord</p>
        <h1 className="mt-2 font-display text-2xl font-semibold md:text-3xl">
          {name ? `Bonjour, ${name}` : 'Bienvenue sur LEANA'}
        </h1>
        <p className="mt-2 max-w-xl text-sm text-ink-muted">
          Votre assistant opérationnel : il comprend, planifie, demande votre accord, exécute et
          vérifie. Les modules s’activent au fil de leur mise en service.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <MissionsPanel />
        <TasksPanel />
        <AgendaPanel />
        <ActivityPanel />
      </div>
    </div>
  );
}
