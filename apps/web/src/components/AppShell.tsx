import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { LogOut, Menu, Sparkles, X } from 'lucide-react';
import { MODULES } from '@/modules';
import { useNotifications } from '@/pages/ActivityPages';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useMe } from '@/lib/useMe';
import { useAuth } from '@/auth/AuthProvider';
import { ApiStatus } from './ApiStatus';

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-4">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-cyan to-violet glow-ring">
        <Sparkles className="size-4 text-night-950" aria-hidden />
      </span>
      <span className="font-display text-lg font-semibold tracking-wide">LEANA</span>
    </div>
  );
}

function Nav() {
  const unread = useNotifications().data?.unread ?? 0;
  return (
    <nav aria-label="Navigation principale" className="flex-1 overflow-y-auto px-2 pb-4">
      <ul className="space-y-0.5">
        {MODULES.map(({ label, path, icon: Icon, phase }) => (
          <li key={path}>
            {phase === null ? (
              <NavLink
                to={path}
                end={path === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-white/8 text-ink shadow-[inset_2px_0_0_var(--color-cyan)]'
                      : 'text-ink-muted hover:bg-white/5 hover:text-ink',
                  )
                }
              >
                <Icon className="size-4" aria-hidden />
                {label}
                {path === '/notifications' && unread > 0 && (
                  <span className="ml-auto rounded-full bg-cyan px-1.5 text-[10px] font-semibold text-night-950">
                    <span aria-hidden>{unread > 99 ? '99+' : unread}</span>
                    <span className="sr-only">
                      {` (${unread} non lue${unread > 1 ? 's' : ''})`}
                    </span>
                  </span>
                )}
              </NavLink>
            ) : (
              <span
                aria-disabled="true"
                title={`Disponible en phase ${phase}`}
                className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-faint"
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
                <span className="ml-auto shrink-0 rounded border border-white/10 px-1.5 text-[10px] uppercase tracking-wider">
                  Bientôt
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function UserMenu() {
  const { session } = useAuth();
  const me = useMe();
  const name = me.data?.profile.display_name || session?.user.email;

  return (
    <div className="flex items-center gap-2">
      <span className="hidden max-w-40 truncate text-sm text-ink-muted sm:inline">{name}</span>
      <button
        type="button"
        onClick={() => supabase.auth.signOut()}
        className="glass p-2 text-ink-muted hover:text-ink"
        aria-label="Se déconnecter"
        title="Se déconnecter"
      >
        <LogOut className="size-4" />
      </button>
    </div>
  );
}

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer whenever the route changes.
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setDrawerOpen(false);
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="flex min-h-dvh">
      <aside className="glass sticky top-3 m-3 hidden h-[calc(100dvh-1.5rem)] w-60 shrink-0 flex-col md:flex">
        <Brand />
        <Nav />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-night-950/70"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside
            id="mobile-nav"
            className="glass absolute inset-y-3 left-3 flex w-64 flex-col"
            aria-label="Menu"
          >
            <div className="flex items-center justify-between pr-2">
              <Brand />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg p-2 text-ink-muted hover:bg-white/5"
                aria-label="Fermer le menu"
              >
                <X className="size-4" />
              </button>
            </div>
            <Nav />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 px-4 pt-4 md:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="glass p-2 md:hidden"
            aria-label="Ouvrir le menu"
            aria-expanded={drawerOpen}
            aria-controls="mobile-nav"
          >
            <Menu className="size-4" />
          </button>
          <div className="ml-auto flex items-center gap-3">
            <ApiStatus />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 md:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
