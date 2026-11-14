import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import {
  ApiError,
  createAgent,
  deleteAgent,
  fetchAgents,
  fetchTools,
  updateAgent,
  type Agent,
  type ToolInfo,
} from '@/lib/api';
import { Field, FormError, Input } from '@/components/Form';
import { cn } from '@/lib/utils';

export const RISK_LABELS: Record<ToolInfo['risk'], string> = {
  read: 'Lecture',
  write: 'Écriture',
  sensitive: 'Sensible',
};
const RISK_STYLES: Record<ToolInfo['risk'], string> = {
  read: 'border-success/30 text-success',
  write: 'border-warning/30 text-warning',
  sensitive: 'border-danger/30 text-danger',
};

function errorMessage(err: unknown) {
  if (err instanceof ApiError) return err.message;
  return 'Le serveur est injoignable.';
}

type Draft = {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  auto_write: boolean;
};
const EMPTY: Draft = { name: '', description: '', instructions: '', tools: [], auto_write: false };

function AgentForm({
  tools,
  initial,
  onDone,
}: {
  tools: ToolInfo[];
  initial?: Agent;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(
    initial
      ? {
          name: initial.name,
          description: initial.description ?? '',
          instructions: initial.instructions,
          tools: initial.tools,
          auto_write: initial.auto_write,
        }
      : EMPTY,
  );
  const mutation = useMutation({
    mutationFn: (body: Draft) =>
      initial
        ? updateAgent(initial.id, { ...body, description: body.description || null })
        : createAgent({ ...body, description: body.description || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      if (!initial) setDraft(EMPTY);
      onDone();
    },
  });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    mutation.reset();
  };
  const hasWrite = draft.tools.some((t) => tools.find((x) => x.name === t)?.risk !== 'read');
  const prefix = initial ? `agent-${initial.id}` : 'agent-new';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (draft.name.trim()) mutation.mutate({ ...draft, name: draft.name.trim() });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={initial ? `Modifier ${initial.name}` : 'Créer un agent'}
      className="space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-name`} label="Nom">
          <Input
            id={`${prefix}-name`}
            value={draft.name}
            maxLength={60}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Ex. : Assistant de recherche"
          />
        </Field>
        <Field id={`${prefix}-description`} label="Description (facultative)">
          <Input
            id={`${prefix}-description`}
            value={draft.description}
            maxLength={300}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
      </div>
      <Field
        id={`${prefix}-instructions`}
        label="Consignes"
        hint="Son rôle et sa façon de travailler. Elles s’ajoutent aux règles de LEANA sans jamais les remplacer."
      >
        <textarea
          id={`${prefix}-instructions`}
          value={draft.instructions}
          maxLength={4000}
          rows={3}
          onChange={(e) => set('instructions', e.target.value)}
          className="w-full resize-y rounded-lg border border-white/10 bg-night-950/60 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none"
        />
      </Field>

      <fieldset>
        <legend className="mb-2 text-xs font-medium text-ink-muted">Outils autorisés</legend>
        <ul className="space-y-2">
          {tools.map((t) => (
            <li key={t.name}>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={draft.tools.includes(t.name)}
                  onChange={(e) =>
                    set(
                      'tools',
                      e.target.checked
                        ? [...draft.tools, t.name]
                        : draft.tools.filter((x) => x !== t.name),
                    )
                  }
                  className="mt-0.5 size-4 accent-cyan"
                />
                <span className="min-w-0">
                  <span className="font-mono text-xs">{t.name}</span>{' '}
                  <span
                    className={cn(
                      'ml-1 rounded border px-1 text-[10px] uppercase',
                      RISK_STYLES[t.risk],
                    )}
                  >
                    {RISK_LABELS[t.risk]}
                  </span>
                  <span className="block text-xs text-ink-faint">{t.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <label className={cn('flex items-start gap-3 text-sm', !hasWrite && 'opacity-50')}>
        <input
          type="checkbox"
          checked={draft.auto_write}
          disabled={!hasWrite}
          onChange={(e) => set('auto_write', e.target.checked)}
          className="mt-0.5 size-4 accent-cyan"
        />
        <span>
          Écrire sans demander
          <span className="block text-xs text-ink-faint">
            Par défaut, chaque outil d’écriture attend votre validation. Les outils sensibles la
            demandent toujours.
          </span>
        </span>
      </label>

      <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!draft.name.trim() || mutation.isPending}
          className="rounded-lg bg-gradient-to-r from-cyan to-electric px-4 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          {initial ? 'Enregistrer' : 'Créer l’agent'}
        </button>
        {initial && (
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-white/5"
          >
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}

function AgentCard({ agent, tools }: { agent: Agent; tools: ToolInfo[] }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteAgent(agent.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });
  const writes = agent.tools.filter((t) => tools.find((x) => x.name === t)?.risk !== 'read');

  return (
    <li className="py-4">
      {editing ? (
        <AgentForm tools={tools} initial={agent} onDone={() => setEditing(false)} />
      ) : (
        <div className="flex items-start gap-3">
          <Bot className="mt-0.5 size-5 shrink-0 text-cyan" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{agent.name}</h3>
            {agent.description && <p className="text-xs text-ink-muted">{agent.description}</p>}
            <p className="mt-1 text-xs text-ink-faint">
              {agent.tools.length
                ? `Outils : ${agent.tools.join(', ')}`
                : 'Aucun outil : il rédige et analyse seulement.'}
            </p>
            {writes.length > 0 && (
              <p
                className={cn(
                  'mt-1 flex items-center gap-1 text-xs',
                  agent.auto_write ? 'text-warning' : 'text-ink-faint',
                )}
              >
                <ShieldAlert className="size-3.5" aria-hidden />
                {agent.auto_write
                  ? 'Écrit sans demander votre validation.'
                  : 'Demande votre validation avant chaque écriture.'}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={`Modifier ${agent.name}`}
            onClick={() => setEditing(true)}
            className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
          >
            <Pencil className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Supprimer ${agent.name}`}
            onClick={() => {
              if (
                window.confirm(
                  `Supprimer l’agent « ${agent.name} » ? Ses missions en cours perdront ses outils.`,
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
      )}
      <FormError message={remove.error ? errorMessage(remove.error) : null} />
    </li>
  );
}

export function AgentsPage() {
  const tools = useQuery({ queryKey: ['tools'], queryFn: ({ signal }) => fetchTools(signal) });
  const agents = useQuery({ queryKey: ['agents'], queryFn: ({ signal }) => fetchAgents(signal) });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <Bot className="size-6 text-cyan" aria-hidden /> Agent Studio
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Un agent est un rôle confié à LEANA pour vos missions, avec les seuls outils que vous lui
          accordez. Chaque appel d’outil est vérifié par le serveur et inscrit dans la mission.
        </p>
      </div>

      {(tools.isError || agents.isError) && (
        <FormError message="Impossible de charger les agents." />
      )}
      {tools.data && (
        <section className="glass p-5" aria-label="Nouvel agent">
          <h2 className="mb-4 text-sm font-medium">Nouvel agent</h2>
          <AgentForm tools={tools.data} onDone={() => {}} />
        </section>
      )}

      <section className="glass p-5" aria-label="Mes agents">
        <h2 className="text-sm font-medium">Mes agents</h2>
        {agents.isPending && <p className="mt-3 text-sm text-ink-muted">Chargement…</p>}
        {agents.data?.length === 0 && (
          <p className="mt-3 text-sm text-ink-muted">
            Aucun agent. Sans agent, une mission n’utilise aucun outil.
          </p>
        )}
        <ul className="divide-y divide-white/5">
          {tools.data &&
            agents.data?.map((a) => <AgentCard key={a.id} agent={a} tools={tools.data} />)}
        </ul>
      </section>
    </div>
  );
}
