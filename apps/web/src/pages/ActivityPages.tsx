import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell } from 'lucide-react';
import { fetchActivity, fetchNotifications, markNotificationsRead } from '@/lib/api';
import { FormError } from '@/components/Form';
import { cn } from '@/lib/utils';

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export function ActivityPage() {
  const activity = useQuery({
    queryKey: ['activity'],
    queryFn: ({ signal }) => fetchActivity(100, signal),
  });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
        <Activity className="size-6 text-cyan" aria-hidden /> Activité
      </h1>
      <p className="text-sm text-ink-muted">
        Tout ce que LEANA a fait ou demandé, dans l’ordre. Ce journal est écrit par le serveur à
        chaque changement d’état et ne peut pas être modifié.
      </p>
      <section className="glass p-4" aria-label="Journal">
        {activity.isPending && <p className="text-sm text-ink-muted">Chargement…</p>}
        {activity.isError && <FormError message="Impossible de charger le journal." />}
        {activity.data?.length === 0 && (
          <p className="text-sm text-ink-muted">Aucune activité enregistrée.</p>
        )}
        <ol className="divide-y divide-white/5">
          {activity.data?.map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4">
              <time className="shrink-0 text-xs text-ink-faint sm:w-36" dateTime={a.created_at}>
                {dateFormat.format(new Date(a.created_at))}
              </time>
              {a.mission_id ? (
                <Link
                  to={`/missions/${a.mission_id}`}
                  className="min-w-0 text-sm break-words hover:text-cyan"
                >
                  {a.summary}
                </Link>
              ) : (
                <span className="min-w-0 text-sm break-words">{a.summary}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** Unread count, refreshed in the background (sidebar badge and dashboard). */
export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: ({ signal }) => fetchNotifications(signal),
    refetchInterval: 30_000,
  });
}

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notifications = useNotifications();
  const mark = useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const data = notifications.data;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <Bell className="size-6 text-cyan" aria-hidden /> Notifications
        </h1>
        {!!data?.unread && (
          <button
            type="button"
            onClick={() => mark.mutate({ all: true })}
            className="text-sm text-cyan hover:underline"
          >
            Tout marquer comme lu
          </button>
        )}
      </div>
      <section className="glass p-4" aria-label="Liste des notifications">
        {notifications.isPending && <p className="text-sm text-ink-muted">Chargement…</p>}
        {notifications.isError && <FormError message="Impossible de charger les notifications." />}
        {data?.items.length === 0 && <p className="text-sm text-ink-muted">Aucune notification.</p>}
        <ul className="divide-y divide-white/5">
          {data?.items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  if (!n.read_at) mark.mutate({ ids: [n.id] });
                  // Links are internal paths (checked in the database).
                  if (n.link?.startsWith('/')) navigate(n.link);
                }}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left hover:bg-white/5"
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full',
                    n.read_at ? 'bg-transparent' : 'bg-cyan',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm break-words', !n.read_at && 'font-medium')}>
                    {n.title}
                    {!n.read_at && <span className="sr-only"> (non lue)</span>}
                  </span>
                  <span className="text-xs text-ink-faint">
                    {dateFormat.format(new Date(n.created_at))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
