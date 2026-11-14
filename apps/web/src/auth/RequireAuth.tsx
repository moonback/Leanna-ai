import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './AuthProvider';

export function RequireAuth() {
  const { session, ready, signedOut } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div role="status" className="grid min-h-dvh place-items-center text-sm text-ink-muted">
        Chargement…
      </div>
    );
  }
  if (!session) {
    // Deep link while signed out: come back here after login. After a sign-out: start fresh.
    if (signedOut) return <Navigate to="/login" replace />;
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}

/** Only same-origin paths are allowed as post-login destinations (no open redirect). */
export function safeNext(raw: string | null) {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
}
