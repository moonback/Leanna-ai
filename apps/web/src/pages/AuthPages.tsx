import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Sparkles } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { safeNext } from '@/auth/RequireAuth';
import { authErrorMessage } from '@/auth/errors';
import { Field, FormError, Input, SubmitButton } from '@/components/Form';

type LayoutProps = { title: string; children: ReactNode; footer: ReactNode };

function AuthLayout({ title, children, footer }: LayoutProps) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-cyan to-violet glow-ring">
            <Sparkles className="size-4 text-night-950" aria-hidden />
          </span>
          <span className="font-display text-xl font-semibold tracking-wide">LEANA</span>
        </div>
        <section className="glass p-6">
          <h1 className="mb-5 font-display text-lg font-semibold">{title}</h1>
          {children}
        </section>
        <p className="mt-4 text-center text-sm text-ink-muted">{footer}</p>
      </div>
    </main>
  );
}

/** Signed-in users never stay on the auth pages. */
function useRedirectIfSignedIn() {
  const { session, ready } = useAuth();
  const [params] = useSearchParams();
  return ready && session ? <Navigate to={safeNext(params.get('next'))} replace /> : null;
}

export function LoginPage() {
  const redirect = useRedirectIfSignedIn();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setPending(false);
    // On success onAuthStateChange sets the session and the redirect takes over.
    if (error) setError(authErrorMessage(error));
  }

  if (redirect) return redirect;
  return (
    <AuthLayout
      title="Connexion"
      footer={
        <>
          Pas encore de compte ?{' '}
          <Link to="/signup" className="text-cyan hover:underline">
            Créer un compte
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field id="email" label="E-mail">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field id="password" label="Mot de passe">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <FormError message={error} />
        <SubmitButton pending={pending}>Se connecter</SubmitButton>
      </form>
    </AuthLayout>
  );
}

export function SignupPage() {
  const redirect = useRedirectIfSignedIn();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    setPending(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({
      email,
      password: String(form.get('password')),
      options: {
        data: { display_name: String(form.get('display_name')).trim() },
        emailRedirectTo: window.location.origin,
      },
    });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    // With email confirmation enabled there is no session until the link is clicked.
    if (!data.session) return setConfirmEmail(email);
    navigate('/', { replace: true });
  }

  if (redirect) return redirect;
  if (confirmEmail) {
    return (
      <AuthLayout
        title="Vérifiez vos e-mails"
        footer={
          <Link to="/login" className="text-cyan hover:underline">
            Retour à la connexion
          </Link>
        }
      >
        <p className="text-sm text-ink-muted">
          Un lien de confirmation a été envoyé à{' '}
          <strong className="text-ink">{confirmEmail}</strong>.
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Créer un compte"
      footer={
        <>
          Déjà inscrit ?{' '}
          <Link to="/login" className="text-cyan hover:underline">
            Se connecter
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field id="display_name" label="Nom affiché">
          <Input
            id="display_name"
            name="display_name"
            autoComplete="name"
            maxLength={80}
            required
          />
        </Field>
        <Field id="email" label="E-mail">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field id="password" label="Mot de passe" hint="8 caractères minimum.">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
        <FormError message={error} />
        <SubmitButton pending={pending}>Créer mon compte</SubmitButton>
      </form>
    </AuthLayout>
  );
}
