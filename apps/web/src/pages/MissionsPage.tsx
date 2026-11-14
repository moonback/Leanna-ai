import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CircleDashed,
  CircleX,
  Loader2,
  Rocket,
  ShieldCheck,
  SkipForward,
  X,
} from 'lucide-react';
import {
  ApiError,
  cancelMission,
  createMission,
  decideApproval,
  fetchMission,
  fetchMissions,
  fetchMissionsConfig,
  fetchAgents,
  type Approval,
  type ToolCall,
  type MissionDetail,
  type MissionStatus,
  type MissionStep,
} from '@/lib/api';
import { FormError } from '@/components/Form';
import { cn } from '@/lib/utils';

export const STATUS_LABELS: Record<MissionStatus, string> = {
  planning: 'Planification',
  awaiting_approval: 'Attend votre validation',
  running: 'En cours',
  completed: 'Terminée',
  failed: 'Échec',
  cancelled: 'Annulée',
};
const STATUS_STYLES: Record<MissionStatus, string> = {
  planning: 'border-cyan/30 bg-cyan/10 text-cyan',
  awaiting_approval: 'border-warning/30 bg-warning/10 text-warning',
  running: 'border-cyan/30 bg-cyan/10 text-cyan',
  completed: 'border-success/30 bg-success/10 text-success',
  failed: 'border-danger/30 bg-danger/10 text-danger',
  cancelled: 'border-white/10 bg-white/5 text-ink-muted',
};
const ERRORS: Record<string, string> = {
  rejected: 'Vous avez refusé une validation.',
  invalid_plan: 'LEANA n’a pas réussi à établir un plan exploitable. Reformulez l’objectif.',
  max_attempts: 'Une étape a échoué trop de fois (fournisseur IA indisponible).',
  quota: 'Quota IA quotidien atteint.',
  ai_not_configured: 'Aucun fournisseur IA n’est configuré pour le worker.',
  payment_required: 'Le compte du fournisseur IA n’a plus de crédits.',
  auth: 'La clé du fournisseur IA est refusée.',
  model_not_found: 'Le modèle n’est pas disponible avec la clé configurée.',
  invalid_request: 'La requête a été refusée par le modèle.',
};
const ACTIVE: MissionStatus[] = ['planning', 'awaiting_approval', 'running'];
const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

function errorMessage(err: unknown) {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Quota IA quotidien atteint. Réessayez demain.';
    if (err.status === 503) return 'Les missions ne sont pas configurées sur ce serveur.';
    if (err.status === 409) return 'Cette action n’est plus possible : la mission a avancé.';
    if (err.status === 404) return 'Cette mission n’existe pas.';
    return err.message;
  }
  return 'Le serveur est injoignable.';
}

export function StatusBadge({ status }: { status: MissionStatus }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]',
        STATUS_STYLES[status],
      )}
    >
      {(status === 'planning' || status === 'running') && (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      )}
      {STATUS_LABELS[status]}
    </span>
  );
}

function NewMission({ configured }: { configured: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [goal, setGoal] = useState('');
  const [agentId, setAgentId] = useState('');
  const agents = useQuery({ queryKey: ['agents'], queryFn: ({ signal }) => fetchAgents(signal) });
  const mutation = useMutation({
    mutationFn: createMission,
    onSuccess: async (mission) => {
      await queryClient.invalidateQueries({ queryKey: ['missions'] });
      navigate(`/missions/${mission.id}`);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (goal.trim()) mutation.mutate({ goal: goal.trim(), agent_id: agentId || null });
  }

  return (
    <form onSubmit={onSubmit} className="glass space-y-3 p-4" aria-label="Créer une mission">
      <label htmlFor="goal" className="block text-sm font-medium">
        Nouvelle mission
      </label>
      <textarea
        id="goal"
        value={goal}
        onChange={(e) => {
          setGoal(e.target.value);
          mutation.reset();
        }}
        rows={3}
        maxLength={4000}
        disabled={!configured}
        placeholder="Ex. : Prépare un plan de révision de 4 semaines pour mon examen de comptabilité, avec un e-mail à envoyer à mon groupe d’étude."
        className="w-full resize-y rounded-lg border border-white/10 bg-night-950/60 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none disabled:opacity-50"
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor="mission-agent" className="text-xs text-ink-muted">
          Agent
        </label>
        <select
          id="mission-agent"
          value={agentId}
          disabled={!configured}
          onChange={(e) => setAgentId(e.target.value)}
          className="rounded-lg border border-white/10 bg-night-950/60 px-3 py-2 text-sm text-ink focus:border-cyan/60 focus:outline-none sm:w-64"
        >
          <option value="">LEANA, sans outil</option>
          {agents.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.tools.length ? ` (${a.tools.length} outil${a.tools.length > 1 ? 's' : ''})` : ''}
            </option>
          ))}
        </select>
        <Link to="/agents" className="text-xs text-cyan hover:underline">
          Gérer les agents
        </Link>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-ink-faint">
          LEANA propose un plan, vous le validez, elle l’exécute. Les étapes et les écritures qui
          vous engagent attendent votre accord.
        </p>
        <button
          type="submit"
          disabled={!configured || !goal.trim() || mutation.isPending}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan to-electric px-4 py-2 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          <Rocket className="size-4" aria-hidden /> Lancer
        </button>
      </div>
      <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
    </form>
  );
}

function MissionList() {
  const config = useQuery({
    queryKey: ['missions-config'],
    queryFn: ({ signal }) => fetchMissionsConfig(signal),
  });
  const missions = useQuery({
    queryKey: ['missions'],
    queryFn: ({ signal }) => fetchMissions(signal),
    // Keep statuses fresh while something is in progress.
    refetchInterval: (q) => (q.state.data?.some((m) => ACTIVE.includes(m.status)) ? 3000 : false),
  });
  const configured = config.data?.configured ?? false;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
        <Rocket className="size-6 text-cyan" aria-hidden /> Missions
      </h1>
      {config.data && !configured && (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          Les missions ne sont pas configurées sur ce serveur (Redis ou fournisseur IA absent).
        </p>
      )}
      <NewMission configured={configured} />

      <section className="glass p-4" aria-label="Mes missions">
        {missions.isPending && <p className="text-sm text-ink-muted">Chargement…</p>}
        {missions.isError && <FormError message={errorMessage(missions.error)} />}
        {missions.data?.length === 0 && (
          <p className="text-sm text-ink-muted">Aucune mission pour l’instant.</p>
        )}
        <ul className="divide-y divide-white/5">
          {missions.data?.map((m) => (
            <li key={m.id}>
              <Link
                to={`/missions/${m.id}`}
                className="flex items-center gap-3 rounded-lg px-2 py-3 hover:bg-white/5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.title}</span>
                  <span className="text-xs text-ink-faint">
                    {dateFormat.format(new Date(m.created_at))}
                  </span>
                </span>
                <StatusBadge status={m.status} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const STEP_ICONS: Record<MissionStep['status'], typeof Check> = {
  pending: CircleDashed,
  running: Loader2,
  done: Check,
  failed: CircleX,
  skipped: SkipForward,
};

function ApprovalCard({ approval, mission }: { approval: Approval; mission: MissionDetail }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => decideApproval(approval.id, decision),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mission', mission.id] }),
        queryClient.invalidateQueries({ queryKey: ['missions'] }),
        queryClient.invalidateQueries({ queryKey: ['approvals'] }),
      ]),
  });
  const step = mission.steps.find((s) => s.id === approval.step_id);

  return (
    <section
      aria-label="Validation requise"
      className="rounded-xl border border-warning/30 bg-warning/5 p-4"
    >
      <h2 className="flex items-center gap-2 text-sm font-medium text-warning">
        <ShieldCheck className="size-4" aria-hidden />
        {approval.kind === 'plan'
          ? 'Valider le plan'
          : approval.kind === 'tool'
            ? 'Autoriser cet outil'
            : 'Valider cette étape'}
      </h2>
      <p className="mt-1 text-sm">{approval.summary}</p>
      <p className="mt-1 text-xs text-ink-muted">
        {approval.kind === 'plan'
          ? 'Rien n’est exécuté avant votre accord. Refuser annule la mission.'
          : approval.kind === 'tool'
            ? 'L’agent attend votre accord pour cette action. Refuser ne l’exécute pas : la mission continue sans elle.'
            : `LEANA va réaliser : ${step?.instruction ?? approval.summary}. Refuser annule la mission.`}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate('approved')}
          className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan to-electric px-3 py-1.5 text-sm font-medium text-night-950 disabled:opacity-40"
        >
          <Check className="size-4" aria-hidden /> Approuver
        </button>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate('rejected')}
          className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40"
        >
          <X className="size-4" aria-hidden /> Refuser
        </button>
      </div>
      <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
    </section>
  );
}

const CALL_LABELS: Record<ToolCall['status'], string> = {
  denied: 'refusé (non autorisé)',
  pending_approval: 'attend votre accord',
  rejected: 'refusé par vous',
  running: 'en cours',
  succeeded: 'fait',
  failed: 'échec',
};

/** What an agent did during a step: every tool call, including refused ones. */
function ToolCalls({ calls }: { calls: ToolCall[] }) {
  if (!calls.length) return null;
  return (
    <ul className="mt-1.5 space-y-1" aria-label="Appels d’outils">
      {calls.map((c) => (
        <li key={c.id} className="text-xs">
          <span className="font-mono text-ink-muted">{c.tool}</span>{' '}
          <span
            className={cn(
              c.status === 'succeeded' && 'text-success',
              (c.status === 'denied' || c.status === 'failed' || c.status === 'rejected') &&
                'text-danger',
              c.status === 'pending_approval' && 'text-warning',
            )}
          >
            {CALL_LABELS[c.status]}
          </span>
          {c.error && c.status === 'failed' && <span className="text-ink-faint"> — {c.error}</span>}
        </li>
      ))}
    </ul>
  );
}

function MissionView({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const mission = useQuery({
    queryKey: ['mission', id],
    queryFn: ({ signal }) => fetchMission(id, signal),
    refetchInterval: (q) => (q.state.data && !ACTIVE.includes(q.state.data.status) ? false : 2000),
  });
  const cancel = useMutation({
    mutationFn: () => cancelMission(id),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mission', id] }),
        queryClient.invalidateQueries({ queryKey: ['missions'] }),
      ]),
  });
  const m = mission.data;
  const pending = m?.approvals.find((a) => a.status === 'pending');

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        to="/missions"
        className="inline-flex items-center gap-2 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Missions
      </Link>
      {mission.isPending && <p className="text-sm text-ink-muted">Chargement…</p>}
      {mission.isError && <FormError message={errorMessage(mission.error)} />}
      {m && (
        <>
          <section className="glass space-y-2 p-5">
            <div className="flex items-start justify-between gap-3">
              <h1 className="font-display text-xl font-semibold break-words">{m.title}</h1>
              <StatusBadge status={m.status} />
            </div>
            <p className="text-sm whitespace-pre-wrap text-ink-muted">{m.goal}</p>
            {m.agent && (
              <p className="text-xs text-ink-faint">
                Agent :{' '}
                <Link to="/agents" className="text-cyan hover:underline">
                  {m.agent.name}
                </Link>
              </p>
            )}
            {m.status === 'planning' && <p className="text-sm text-cyan">LEANA prépare un plan…</p>}
            {m.status === 'failed' && (
              <p role="alert" className="text-sm text-danger">
                {ERRORS[m.error_code ?? ''] ?? 'La mission a échoué.'}
              </p>
            )}
            {m.status === 'cancelled' && m.error_code === 'rejected' && (
              <p className="text-sm text-ink-muted">{ERRORS.rejected}</p>
            )}
            {ACTIVE.includes(m.status) && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Arrêter cette mission ? L’étape en cours sera abandonnée.')) {
                    cancel.mutate();
                  }
                }}
                className="text-sm text-danger hover:underline"
              >
                Arrêter la mission
              </button>
            )}
            <FormError message={cancel.error ? errorMessage(cancel.error) : null} />
          </section>

          {pending && <ApprovalCard approval={pending} mission={m} />}

          {m.steps.length > 0 && (
            <section className="glass p-5" aria-label="Plan">
              <h2 className="mb-3 text-sm font-medium">Plan</h2>
              <ol className="space-y-3">
                {m.steps.map((s) => {
                  const Icon = STEP_ICONS[s.status];
                  return (
                    <li key={s.id} className="flex gap-3" data-status={s.status}>
                      <Icon
                        className={cn(
                          'mt-0.5 size-4 shrink-0',
                          s.status === 'running' && 'animate-spin text-cyan',
                          s.status === 'done' && 'text-success',
                          s.status === 'failed' && 'text-danger',
                          (s.status === 'pending' || s.status === 'skipped') && 'text-ink-faint',
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {s.position}. {s.title}
                          {s.requires_approval && (
                            <span className="ml-2 text-[11px] text-warning">
                              validation requise
                            </span>
                          )}
                          {s.attempt > 1 && (
                            <span className="ml-2 text-[11px] text-ink-faint">
                              tentative {s.attempt}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-ink-faint">{s.instruction}</p>
                        <ToolCalls calls={m.tool_calls.filter((c) => c.step_id === s.id)} />
                        {s.output && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-cyan">
                              Résultat de l’étape
                            </summary>
                            <p className="mt-1 text-sm whitespace-pre-wrap break-words">
                              {s.output}
                            </p>
                          </details>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {m.result && (
            <section className="glass p-5" aria-label="Résultat">
              <h2 className="mb-2 text-sm font-medium text-success">Résultat</h2>
              {/* Plain text only: model output is never interpreted as HTML. */}
              <p className="text-sm whitespace-pre-wrap break-words">{m.result}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function MissionsPage() {
  const { id } = useParams();
  return id ? <MissionView key={id} id={id} /> : <MissionList />;
}
