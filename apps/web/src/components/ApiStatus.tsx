import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '@/lib/api';
import { cn } from '@/lib/utils';

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

const STYLES = {
  offline: { dot: 'bg-warning', label: 'Hors ligne' },
  loading: { dot: 'bg-ink-faint animate-pulse', label: 'Connexion…' },
  ok: { dot: 'bg-success', label: 'API connectée' },
  error: { dot: 'bg-danger', label: 'API injoignable' },
} as const;

export function ApiStatus() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 30_000,
  });

  const state = !online
    ? 'offline'
    : health.isPending
      ? 'loading'
      : health.isError
        ? 'error'
        : 'ok';
  const { dot, label } = STYLES[state];

  return (
    <div
      role="status"
      data-state={state}
      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-ink-muted"
    >
      <span aria-hidden className={cn('size-2 rounded-full', dot)} />
      <span>{label}</span>
      {state === 'error' && (
        <button
          type="button"
          onClick={() => health.refetch()}
          className="ml-1 text-cyan underline-offset-2 hover:underline"
        >
          Réessayer
        </button>
      )}
    </div>
  );
}
