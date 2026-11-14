import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, History, Pencil, RotateCcw, Search, Trash2 } from 'lucide-react';
import {
  ApiError,
  clearMemories,
  createMemory,
  deleteMemory,
  fetchAiConfig,
  fetchMemories,
  reindexMemories,
  restoreMemory,
  updateMemory,
  type Memory,
  type MemoryKind,
} from '@/lib/api';
import { useMe } from '@/lib/useMe';
import { FormError, Input, Select } from '@/components/Form';
import { cn } from '@/lib/utils';

export const KIND_LABELS: Record<MemoryKind, string> = {
  fact: 'Fait',
  preference: 'Préférence',
  goal: 'Objectif',
  relationship: 'Relation',
};
const KINDS = Object.keys(KIND_LABELS) as MemoryKind[];

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

function errorMessage(err: unknown) {
  if (err instanceof ApiError && err.status === 409) return 'LEANA le sait déjà.';
  if (err instanceof ApiError) return err.message;
  return 'Le serveur est injoignable.';
}

function AddMemory() {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const mutation = useMutation({
    mutationFn: createMemory,
    onSuccess: () => {
      setContent('');
      return queryClient.invalidateQueries({ queryKey: ['memories'] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (content.trim()) mutation.mutate({ content: content.trim(), kind });
  }

  return (
    <form onSubmit={onSubmit} className="glass space-y-3 p-4" aria-label="Ajouter un souvenir">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="new-memory" className="sr-only">
          Ce que LEANA doit retenir
        </label>
        <Input
          id="new-memory"
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            mutation.reset();
          }}
          maxLength={500}
          placeholder="Ex. : Je préfère être tutoyée, je travaille chez Acme…"
        />
        <label htmlFor="new-memory-kind" className="sr-only">
          Type
        </label>
        <Select
          id="new-memory-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind)}
          className="sm:w-40"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <button
          type="submit"
          disabled={!content.trim() || mutation.isPending}
          className="shrink-0 rounded-lg bg-gradient-to-r from-cyan to-electric px-4 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          Retenir
        </button>
      </div>
      <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
    </form>
  );
}

function MemoryItem({ memory, semantic }: { memory: Memory; semantic: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['memories'] });
  const save = useMutation({
    mutationFn: () => updateMemory(memory.id, { content: draft.trim() }),
    onSuccess: () => {
      setEditing(false);
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => deleteMemory(memory.id), onSuccess: refresh });
  const restore = useMutation({ mutationFn: () => restoreMemory(memory.id), onSuccess: refresh });
  const error = save.error ?? remove.error ?? restore.error;
  const active = memory.status === 'active';

  return (
    <li className="space-y-2 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-md border border-cyan/25 bg-cyan/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-cyan">
          {KIND_LABELS[memory.kind]}
        </span>
        {editing ? (
          <form
            className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) save.mutate();
            }}
          >
            <label htmlFor={`edit-${memory.id}`} className="sr-only">
              Corriger le souvenir
            </label>
            <Input
              id={`edit-${memory.id}`}
              value={draft}
              maxLength={500}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!draft.trim() || save.isPending}
                className="rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-1.5 text-sm text-cyan disabled:opacity-40"
              >
                Enregistrer
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(memory.content);
                }}
                className="rounded-lg px-3 py-1.5 text-sm text-ink-muted hover:bg-white/5"
              >
                Annuler
              </button>
            </div>
          </form>
        ) : (
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm break-words', !active && 'text-ink-muted line-through')}>
              {memory.content}
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              {memory.source === 'conversation' ? 'Retenu d’une conversation' : 'Ajouté par vous'}
              {' · '}
              {dateFormat.format(new Date(memory.updated_at))}
              {!active &&
                (memory.superseded_by
                  ? ' · remplacé par une information plus récente'
                  : ' · oublié')}
              {active && semantic && !memory.indexed && ' · pas encore indexé'}
            </p>
          </div>
        )}
        {!editing && (
          <div className="flex shrink-0 items-center">
            {active ? (
              <button
                type="button"
                aria-label={`Corriger « ${memory.content} »`}
                onClick={() => setEditing(true)}
                className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
              >
                <Pencil className="size-4" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                aria-label={`Restaurer « ${memory.content} »`}
                onClick={() => restore.mutate()}
                className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-ink"
              >
                <RotateCcw className="size-4" aria-hidden />
              </button>
            )}
            <button
              type="button"
              aria-label={`Supprimer « ${memory.content} »`}
              onClick={() => {
                if (window.confirm(`Supprimer définitivement « ${memory.content} » ?`)) {
                  remove.mutate();
                }
              }}
              className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-danger"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
      <FormError message={error ? errorMessage(error) : null} />
    </li>
  );
}

export function MemoryPage() {
  const queryClient = useQueryClient();
  const me = useMe();
  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: ({ signal }) => fetchAiConfig(signal),
  });
  const [status, setStatus] = useState<Memory['status']>('active');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const memories = useQuery({
    queryKey: ['memories', status, q],
    queryFn: ({ signal }) => fetchMemories({ status, q: q || undefined }, signal),
  });
  const clear = useMutation({
    mutationFn: clearMemories,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['memories'] }),
  });
  const reindex = useMutation({
    mutationFn: reindexMemories,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['memories'] }),
  });

  const semantic = !!config.data?.embeddings;
  const unindexed = memories.data?.filter((m) => m.status === 'active' && !m.indexed).length ?? 0;
  const disabled = me.data && !me.data.preferences.memory_enabled;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <Brain className="size-6 text-cyan" aria-hidden /> Mémoire
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Ce que LEANA sait de vous. Elle retient d’elle-même les informations durables que vous
          partagez dans l’Assistant et s’en sert pour personnaliser ses réponses. Tout est
          modifiable et supprimable ici.
        </p>
      </div>

      {disabled && (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          La mémoire est désactivée : LEANA n’apprend rien et n’utilise pas ces souvenirs.{' '}
          <Link to="/settings" className="underline">
            Réactiver dans Paramètres
          </Link>
        </p>
      )}

      <AddMemory />

      <section className="glass p-4" aria-label="Souvenirs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div role="tablist" aria-label="Filtre" className="flex gap-1">
            {(['active', 'superseded'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={status === s}
                onClick={() => setStatus(s)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm',
                  status === s ? 'bg-white/8 text-ink' : 'text-ink-muted hover:bg-white/5',
                )}
              >
                {s === 'superseded' && <History className="size-3.5" aria-hidden />}
                {s === 'active' ? 'Actifs' : 'Historique'}
              </button>
            ))}
          </div>
          <form
            role="search"
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(search.trim());
            }}
          >
            <label htmlFor="memory-search" className="sr-only">
              Rechercher dans la mémoire
            </label>
            <Input
              id="memory-search"
              type="search"
              value={search}
              maxLength={500}
              onChange={(e) => {
                setSearch(e.target.value);
                if (!e.target.value) setQ('');
              }}
              placeholder={semantic ? 'Rechercher (par le sens)' : 'Rechercher (mots-clés)'}
              className="sm:w-64"
            />
            <button
              type="submit"
              aria-label="Rechercher"
              className="rounded-lg border border-white/10 p-2 text-ink-muted hover:bg-white/5"
            >
              <Search className="size-4" aria-hidden />
            </button>
          </form>
        </div>

        {memories.isPending && <p className="mt-4 text-sm text-ink-muted">Chargement…</p>}
        {memories.isError && (
          <div className="mt-4 space-y-2">
            <FormError message={errorMessage(memories.error)} />
            <button
              type="button"
              onClick={() => memories.refetch()}
              className="text-sm text-cyan hover:underline"
            >
              Réessayer
            </button>
          </div>
        )}
        {memories.data?.length === 0 && (
          <p className="mt-6 text-sm text-ink-muted">
            {q
              ? 'Aucun souvenir ne correspond à cette recherche.'
              : status === 'active'
                ? 'LEANA ne sait encore rien de vous. Parlez-lui de vous dans l’Assistant, ou ajoutez un souvenir ci-dessus.'
                : 'Aucun souvenir remplacé ou oublié.'}
          </p>
        )}
        {!!memories.data?.length && (
          <ul className="mt-2 divide-y divide-white/5">
            {memories.data.map((m) => (
              <MemoryItem key={m.id} memory={m} semantic={semantic} />
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3 text-xs text-ink-faint">
          <span>
            {semantic
              ? 'Recherche hybride : mots-clés et sens.'
              : 'Recherche par mots-clés uniquement (aucun modèle d’embeddings configuré sur le serveur).'}
          </span>
          <div className="flex gap-3">
            {semantic && unindexed > 0 && status === 'active' && !q && (
              <button
                type="button"
                onClick={() => reindex.mutate()}
                disabled={reindex.isPending}
                className="text-cyan hover:underline disabled:opacity-50"
              >
                Indexer {unindexed} souvenir{unindexed > 1 ? 's' : ''}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    'Effacer définitivement tous vos souvenirs, historique compris ? Cette action est irréversible.',
                  )
                ) {
                  clear.mutate();
                }
              }}
              className="text-danger hover:underline"
            >
              Tout effacer
            </button>
          </div>
        </div>
        <FormError
          message={clear.error || reindex.error ? errorMessage(clear.error ?? reindex.error) : null}
        />
      </section>
    </div>
  );
}
