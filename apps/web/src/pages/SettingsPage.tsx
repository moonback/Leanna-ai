import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAiConfig, updatePreferences, updateProfile, type Profile } from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { Field, FormError, Input, Select, SubmitButton } from '@/components/Form';

const ROLE_LABELS = { owner: 'Propriétaire', admin: 'Administrateur', member: 'Membre' } as const;
const TIME_ZONES = Intl.supportedValuesOf('timeZone');

/** "Configurer son IA": the model list comes from the server allowlist. */
function AiSettings({ current }: { current: string | null }) {
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: ({ signal }) => fetchAiConfig(signal),
  });
  const mutation = useMutation({
    mutationFn: updatePreferences,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <section className="glass p-6" aria-labelledby="ai-title">
      <h2 id="ai-title" className="mb-1 text-sm font-medium">
        Intelligence artificielle
      </h2>
      <p className="mb-5 text-xs text-ink-faint">
        Fournisseur : Google Gemini. Les clés restent sur le serveur.
      </p>
      {config.isPending && <p className="text-sm text-ink-muted">Chargement…</p>}
      {config.isError && <FormError message="Impossible de charger la configuration IA." />}
      {config.data && !config.data.configured && (
        <p className="text-sm text-warning">
          L’assistant n’est pas configuré sur ce serveur (clé Gemini absente).
        </p>
      )}
      {config.data?.configured && (
        <Field
          id="ai_model"
          label="Modèle"
          hint="Les modèles proposés sont ceux autorisés par le serveur."
        >
          <Select
            id="ai_model"
            value={mutation.isPending ? (mutation.variables?.ai_model ?? '') : (current ?? '')}
            disabled={mutation.isPending}
            onChange={(e) => mutation.mutate({ ai_model: e.target.value || null })}
          >
            <option value="">Par défaut ({config.data.default_model})</option>
            {config.data.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="mt-3">
        <FormError message={mutation.error?.message ?? null} />
        {mutation.isSuccess && (
          <p role="status" className="text-sm text-success">
            Préférence IA enregistrée.
          </p>
        )}
      </div>
    </section>
  );
}

function ProfileForm({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: () => {
      setSaved(true);
      return queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaved(false);
    mutation.mutate({
      display_name: String(form.get('display_name')),
      locale: form.get('locale') as Profile['locale'],
      timezone: String(form.get('timezone')),
    });
  }

  const zones = TIME_ZONES.includes(profile.timezone)
    ? TIME_ZONES
    : [profile.timezone, ...TIME_ZONES];

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="display_name" label="Nom affiché">
        <Input
          id="display_name"
          name="display_name"
          defaultValue={profile.display_name ?? ''}
          maxLength={80}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="locale" label="Langue">
          <Select id="locale" name="locale" defaultValue={profile.locale}>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </Select>
        </Field>
        <Field id="timezone" label="Fuseau horaire">
          <Select id="timezone" name="timezone" defaultValue={profile.timezone}>
            {zones.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
      </div>
      <FormError message={mutation.error?.message ?? null} />
      {saved && (
        <p role="status" className="text-sm text-success">
          Profil enregistré.
        </p>
      )}
      <div className="sm:w-48">
        <SubmitButton pending={mutation.isPending}>Enregistrer</SubmitButton>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const me = useMe();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="font-display text-2xl font-semibold">Paramètres</h1>

      {me.isPending && <p className="text-sm text-ink-muted">Chargement du profil…</p>}
      {me.isError && (
        <div className="glass p-5">
          <FormError message={`Impossible de charger le profil : ${me.error.message}`} />
          <button
            type="button"
            onClick={() => me.refetch()}
            className="mt-3 text-sm text-cyan hover:underline"
          >
            Réessayer
          </button>
        </div>
      )}
      {me.data && (
        <>
          <section className="glass p-6" aria-labelledby="profile-title">
            <h2 id="profile-title" className="text-sm font-medium">
              Profil
            </h2>
            <p className="mb-5 text-xs text-ink-faint">{me.data.email}</p>
            <ProfileForm profile={me.data.profile} />
          </section>

          <AiSettings current={me.data.preferences.ai_model} />

          <section className="glass p-6" aria-labelledby="ws-title">
            <h2 id="ws-title" className="mb-3 text-sm font-medium">
              Espaces de travail
            </h2>
            <ul className="divide-y divide-white/5">
              {me.data.workspaces.map((ws) => (
                <li key={ws.id} className="flex items-center justify-between py-2.5 text-sm">
                  <span>{ws.name}</span>
                  <span className="text-xs text-ink-muted">{ROLE_LABELS[ws.role]}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
