import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageSquarePlus, Send, Sparkles, Square, Trash2 } from 'lucide-react';
import {
  ApiError,
  createConversation,
  deleteConversation,
  fetchAiConfig,
  fetchConversations,
  fetchMessages,
  streamMessage,
  type ChatMessage,
} from '@/lib/api';
import { FormError } from '@/components/Form';
import { cn } from '@/lib/utils';

const AI_ERRORS: Record<string, string> = {
  timeout: 'Le modèle n’a pas répondu à temps.',
  rate_limited: 'Le fournisseur IA est saturé. Réessayez dans un instant.',
  unavailable: 'Le service IA est momentanément indisponible.',
  auth: 'La clé du fournisseur IA est refusée (configuration du serveur).',
  model_not_found: 'Ce modèle n’est pas disponible avec la clé configurée.',
  invalid_request: 'La requête a été refusée par le modèle.',
  empty_response: 'Le modèle n’a renvoyé aucun texte.',
  internal: 'Une erreur interne est survenue.',
};

function requestErrorMessage(err: unknown) {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Quota IA quotidien atteint. Réessayez demain.';
    if (err.status === 503) return 'L’assistant IA n’est pas configuré sur ce serveur.';
    if (err.status === 404) return 'Cette conversation n’existe plus.';
    return err.message;
  }
  return AI_ERRORS.unavailable!;
}

type BubbleProps = {
  role: ChatMessage['role'];
  content: string;
  status?: ChatMessage['status'];
  errorCode?: string | null;
  streaming?: boolean;
};

function Bubble({ role, content, status, errorCode, streaming }: BubbleProps) {
  const mine = role === 'user';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        data-role={role}
        className={cn(
          // Plain text only: model output is never interpreted as HTML.
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border px-4 py-2.5 text-sm leading-relaxed',
          mine ? 'border-electric/30 bg-electric/15' : 'border-white/10 bg-white/5',
        )}
      >
        {content ||
          (streaming && <span className="animate-pulse text-ink-muted">LEANA rédige…</span>)}
        {status && status !== 'complete' && (
          <p className="mt-2 text-xs text-danger">
            {status === 'interrupted'
              ? 'Réponse interrompue.'
              : (AI_ERRORS[errorCode ?? ''] ?? AI_ERRORS.internal)}
          </p>
        )}
      </div>
    </div>
  );
}

function ConversationList({ activeId }: { activeId?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['conversations'],
    queryFn: ({ signal }) => fetchConversations(signal),
  });
  const remove = useMutation({
    mutationFn: deleteConversation,
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (id === activeId) navigate('/assistant');
    },
  });

  return (
    <aside
      aria-label="Conversations"
      className={cn(
        'glass w-full flex-col p-3 lg:flex lg:h-[calc(100dvh-7.5rem)] lg:w-72 lg:shrink-0',
        activeId ? 'hidden' : 'flex',
      )}
    >
      <Link
        to="/assistant"
        className="mb-3 flex items-center justify-center gap-2 rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-2 text-sm text-cyan hover:bg-cyan/15"
      >
        <MessageSquarePlus className="size-4" aria-hidden />
        Nouvelle conversation
      </Link>
      {list.isPending && <p className="px-2 text-sm text-ink-muted">Chargement…</p>}
      {list.isError && (
        <div className="space-y-2 px-1">
          <FormError message="Impossible de charger les conversations." />
          <button
            type="button"
            onClick={() => list.refetch()}
            className="text-sm text-cyan hover:underline"
          >
            Réessayer
          </button>
        </div>
      )}
      {list.data?.length === 0 && (
        <p className="px-2 text-sm text-ink-muted">Aucune conversation pour l’instant.</p>
      )}
      <ul className="space-y-0.5 overflow-y-auto">
        {list.data?.map((c) => {
          const title = c.title ?? 'Sans titre';
          return (
            <li key={c.id} className="group flex items-center gap-1">
              <Link
                to={`/assistant/${c.id}`}
                aria-current={c.id === activeId ? 'page' : undefined}
                className={cn(
                  'min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-sm',
                  c.id === activeId
                    ? 'bg-white/8 text-ink'
                    : 'text-ink-muted hover:bg-white/5 hover:text-ink',
                )}
              >
                {title}
              </Link>
              <button
                type="button"
                aria-label={`Supprimer « ${title} »`}
                onClick={() => {
                  if (
                    window.confirm(`Supprimer définitivement « ${title} » et tous ses messages ?`)
                  ) {
                    remove.mutate(c.id);
                  }
                }}
                className="rounded-lg p-2 text-ink-faint hover:bg-white/5 hover:text-danger focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function Thread({ conversationId }: { conversationId?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: ({ signal }) => fetchAiConfig(signal),
  });
  const messages = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: ({ signal }) => fetchMessages(conversationId!, signal),
    enabled: !!conversationId,
  });
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<{ user: string; answer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view by scrolling the thread only, never the whole page.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.data, live]);

  const configured = config.data?.configured ?? false;

  async function send(content: string) {
    setError(null);
    let id = conversationId;
    if (!id) {
      try {
        id = (await createConversation()).id;
      } catch (err) {
        return setError(requestErrorMessage(err));
      }
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLive({ user: content, answer: '' });
    setDraft('');
    try {
      await streamMessage(
        id,
        content,
        (event) => {
          if (event.event === 'delta') {
            const { text } = event.data as { text: string };
            setLive((l) => l && { ...l, answer: l.answer + text });
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError(requestErrorMessage(err));
        // Refused before anything was stored (quota, config): give the text back.
        if (err instanceof ApiError) setDraft(content);
      }
    } finally {
      abortRef.current = null;
      // The server stored the final (or failed) answer: show the persisted version.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', id] }),
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
      setLive(null);
      if (id !== conversationId) navigate(`/assistant/${id}`);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (content && !live && configured) void send(content);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) onSubmit(e);
  }

  const empty = !conversationId && !live;

  return (
    <section
      aria-label="Discussion"
      className="glass flex h-[calc(100dvh-7.5rem)] min-h-96 min-w-0 flex-1 flex-col"
    >
      {conversationId && (
        <Link
          to="/assistant"
          className="flex items-center gap-2 border-b border-white/5 px-4 py-3 text-sm text-ink-muted lg:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden /> Conversations
        </Link>
      )}
      {config.data && !configured && (
        <p
          role="status"
          className="m-4 mb-0 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          L’assistant IA n’est pas configuré sur ce serveur : une clé Gemini doit être ajoutée côté
          API.
        </p>
      )}

      <div
        ref={logRef}
        role="log"
        aria-busy={!!live}
        aria-label="Messages"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
      >
        {empty && (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm">
              <Sparkles className="mx-auto mb-3 size-8 text-cyan" aria-hidden />
              <h1 className="font-display text-xl font-semibold">Que puis-je faire pour vous ?</h1>
              <p className="mt-2 text-sm text-ink-muted">
                Posez une question ou décrivez ce dont vous avez besoin. LEANA ne dispose pas encore
                d’outils ni de mémoire à long terme : elle vous le dira plutôt que de faire
                semblant.
              </p>
            </div>
          </div>
        )}
        {conversationId && messages.isPending && (
          <p className="text-sm text-ink-muted">Chargement des messages…</p>
        )}
        {messages.isError && (
          <div className="space-y-2">
            <FormError message={requestErrorMessage(messages.error)} />
            <button
              type="button"
              onClick={() => messages.refetch()}
              className="text-sm text-cyan hover:underline"
            >
              Réessayer
            </button>
          </div>
        )}
        {messages.data?.map((m) => (
          <Bubble
            key={m.id}
            role={m.role}
            content={m.content}
            status={m.status}
            errorCode={m.error_code}
          />
        ))}
        {live && (
          <>
            <Bubble role="user" content={live.user} />
            <Bubble role="assistant" content={live.answer} streaming />
          </>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-white/5 p-3">
        <FormError message={error} />
        <div className="mt-2 flex items-end gap-2">
          <label htmlFor="composer" className="sr-only">
            Message pour LEANA
          </label>
          <textarea
            id="composer"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={8000}
            disabled={!configured}
            placeholder={
              configured
                ? 'Écrivez à LEANA… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)'
                : ''
            }
            className="min-h-11 flex-1 resize-none rounded-lg border border-white/10 bg-night-950/60 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none disabled:opacity-50"
          />
          {live ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2.5 text-sm text-ink hover:bg-white/5"
            >
              <Square className="size-3.5" aria-hidden /> Arrêter
            </button>
          ) : (
            <button
              type="submit"
              disabled={!configured || !draft.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan to-electric px-3 py-2.5 text-sm font-medium text-night-950 disabled:opacity-40"
            >
              <Send className="size-3.5" aria-hidden /> Envoyer
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

export function AssistantPage() {
  const { id } = useParams();
  return (
    <div className="mx-auto flex max-w-6xl gap-4">
      <ConversationList activeId={id} />
      <Thread key={id ?? 'new'} conversationId={id} />
    </div>
  );
}
