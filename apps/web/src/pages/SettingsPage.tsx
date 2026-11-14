import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAiConfig,
  updatePreferences,
  updateProfile,
  type AiPreference,
  type Profile,
  type ProviderId,
} from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { Field, FormError, Input, Select, SubmitButton } from '@/components/Form';

const ROLE_LABELS = { owner: 'Propriétaire', admin: 'Administrateur', member: 'Membre' } as const;
const TIME_ZONES = Intl.supportedValuesOf('timeZone');

/**
 * "Configurer son IA": pick the provider, then one of its models. Lists come from the
 * server allowlist; a provider without a key on the server is shown but cannot be chosen.
 */
function AiSettings({ current }: { current: AiPreference }) {
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: ({ signal }) => fetchAiConfig(signal),
  });
  const [provider, setProvider] = useState<ProviderId | ''>(current.ai_provider ?? '');
  const [model, setModel] = useState(current.ai_model ?? '');
  const mutation = useMutation({
    mutationFn: updatePreferences,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  const providers = config.data?.providers ?? [];
  const selected = providers.find((p) => p.id === provider);
  const fallback = config.data?.default;
  const fallbackLabel = fallback
    ? `${providers.find((p) => p.id === fallback.provider)?.label} · ${fallback.model}`
    : '';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate({ ai_provider: provider || null, ai_model: (provider && model) || null });
  }

  return (
    <section className="glass p-6" aria-labelledby="ai-title">
      <h2 id="ai-title" className="mb-1 text-sm font-medium">
        Intelligence artificielle
      </h2>
      <p className="mb-5 text-xs text-ink-faint">
        Choisissez le fournisseur et le modèle utilisés par LEANA. Les clés restent sur le serveur.
      </p>
      {config.isPending && <p className="text-sm text-ink-muted">Chargement…</p>}
      {config.isError && <FormError message="Impossible de charger la configuration IA." />}
      {config.data && !config.data.configured && (
        <p className="text-sm text-warning">
          Aucun fournisseur IA n’est configuré sur ce serveur (clés Gemini et OpenRouter absentes).
        </p>
      )}
      {config.data?.configured && (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ai_provider" label="Fournisseur">
              <Select
                id="ai_provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as ProviderId | '');
                  setModel('');
                  mutation.reset();
                }}
              >
                <option value="">Par défaut ({fallbackLabel})</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.label}
                    {p.configured ? '' : ' — clé absente sur le serveur'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="ai_model"
              label="Modèle"
              hint={
                selected
                  ? 'Modèles autorisés par le serveur.'
                  : 'Choisissez d’abord un fournisseur.'
              }
            >
              <Select
                id="ai_model"
                value={model}
                disabled={!selected}
                onChange={(e) => {
                  setModel(e.target.value);
                  mutation.reset();
                }}
              >
                <option value="">
                  {selected ? `Par défaut (${selected.default_model})` : '—'}
                </option>
                {selected?.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <FormError message={mutation.error?.message ?? null} />
          {mutation.isSuccess && (
            <p role="status" className="text-sm text-success">
              Préférence IA enregistrée.
            </p>
          )}
          <div className="sm:w-48">
            <SubmitButton pending={mutation.isPending}>Enregistrer l’IA</SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}

/** Memory switch: off = no recall in replies and nothing new learned. */
function MemorySettings({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  // Optimistic: the box follows the click at once and is rolled back if saving fails.
  const [on, setOn] = useState(enabled);
  const mutation = useMutation({
    mutationFn: (memory_enabled: boolean) => updatePreferences({ memory_enabled }),
    onError: (_, value) => setOn(!value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <section className="glass p-6" aria-labelledby="memory-title">
      <h2 id="memory-title" className="mb-1 text-sm font-medium">
        Mémoire
      </h2>
      <p className="mb-4 text-xs text-ink-faint">
        LEANA retient les informations durables que vous partagez (métier, préférences, objectifs…)
        et s’en sert dans ses réponses. Consultez-les et corrigez-les dans{' '}
        <Link to="/memory" className="text-cyan hover:underline">
          Mémoire
        </Link>
        .
      </p>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={mutation.isPending}
          onChange={(e) => {
            setOn(e.target.checked);
            mutation.mutate(e.target.checked);
          }}
          className="size-4 accent-cyan"
        />
        Activer la mémoire
      </label>
      <p className="mt-2 text-xs text-ink-faint">
        Désactivée, LEANA n’apprend plus rien et n’utilise plus vos souvenirs ; ceux déjà
        enregistrés sont conservés jusqu’à ce que vous les supprimiez.
      </p>
      <FormError message={mutation.error?.message ?? null} />
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

          <AiSettings
            key={`${me.data.preferences.ai_provider}/${me.data.preferences.ai_model}`}
            current={me.data.preferences}
          />
          <MemorySettings enabled={me.data.preferences.memory_enabled} />

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
