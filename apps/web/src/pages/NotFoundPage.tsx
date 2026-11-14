import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="glass mx-auto max-w-md p-8 text-center">
      <h1 className="font-display text-xl font-semibold">Page introuvable</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Ce module n’existe pas ou n’est pas encore disponible.
      </p>
      <Link to="/" className="mt-4 inline-block text-sm text-cyan hover:underline">
        Retour au tableau de bord
      </Link>
    </div>
  );
}
