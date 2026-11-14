import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import type { AiChoice, Gateway } from '../ai/gateway.js';
import type { Embedder } from '../ai/embeddings.js';
import { AiError, type ChatTurn, type ProviderId } from '../ai/types.js';
import {
  LAST_ROUND,
  MAX_TOOL_CALLS_PER_STEP,
  parseAgentReply,
  toolInstructions,
  toolResultMessage,
} from '../tools/protocol.js';
import { needsApproval, ToolError, TOOLS, TOOLS_BY_NAME, type Tool } from '../tools/registry.js';
import { parsePlan, PLAN_SYSTEM, planInput, STEP_SYSTEM, stepInput } from './plan.js';

/**
 * Mission Engine. One call to `run(missionId)` advances a mission as far as it can:
 *   planning          → plan (one model call), then ask the user to approve it
 *   awaiting_approval → resume when the pending approval was granted
 *   running           → execute steps in order; a step flagged `requires_approval`
 *                       first asks for a decision, the last output becomes the result
 *
 * Guarantees, all enforced through the database:
 *   - one processor per mission: a Postgres advisory lock held on a dedicated connection
 *     (a crashed worker's connection dies, so its lock is released at once);
 *   - fencing: claiming a step increments `attempt`, and only the claimed attempt may
 *     complete it, so a zombie worker can never overwrite a newer result;
 *   - bounded retries: a step that hits MISSION_MAX_ATTEMPTS incidents (crash, outage)
 *     fails the mission; pausing for a tool approval is not an incident;
 *   - every state change goes through the SQL state machine and lands in `activity`.
 *
 * With an agent, a step is a tool loop (see tools/protocol.ts): every call is recorded in
 * `tool_calls` and goes through the SQL permission gate; a call that needs approval pauses
 * the step, and the step's earlier calls are replayed to the model when it resumes.
 */
export type EngineOptions = {
  sql: Sql;
  gateway: Gateway | null;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  leaseMs: number;
  maxAttempts: number;
  dailyTokenLimit: number;
  maxOutputTokens: number;
  embedder?: Embedder | null;
  maxDistance?: number;
};

export type RunOutcome =
  | 'busy'
  | 'missing'
  | 'finished'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

type Mission = {
  id: string;
  user_id: string;
  goal: string;
  title: string;
  status: string;
  provider: ProviderId | null;
  model: string | null;
  agent_id: string | null;
};
type Agent = {
  id: string;
  name: string;
  instructions: string;
  tools: string[];
  auto_write: boolean;
  provider: ProviderId | null;
  model: string | null;
};
type Step = {
  id: string;
  position: number;
  title: string;
  instruction: string;
  requires_approval: boolean;
  status: string;
  attempt: number;
  failures: number;
  output: string | null;
};
type ToolCallRow = {
  id: string;
  tool: string;
  input: unknown;
  status: string;
  output: unknown;
  error: string | null;
};
/** The step paused on a tool approval. */
const PAUSED = Symbol('paused');

/** Errors that will not get better by retrying: the mission fails right away. */
const FATAL = new Set(['invalid_request', 'model_not_found', 'payment_required', 'auth']);

export function createMissionEngine(opts: EngineOptions) {
  const { sql, gateway, log } = opts;

  const load = async (id: string) =>
    (
      await sql<Mission[]>`
        select id, user_id, goal, title, status, provider, model, agent_id
        from public.missions where id = ${id}`
    )[0];

  const fail = (id: string, code: string) => sql`
    update public.missions set status = 'failed', error_code = ${code.slice(0, 32)}
    where id = ${id} and status in ('planning', 'awaiting_approval', 'running')`;

  const loadAgent = async (id: string | null) =>
    id
      ? (
          await sql<Agent[]>`
            select id, name, instructions, tools, auto_write, provider, model
            from public.agents where id = ${id}`
        )[0]
      : undefined;

  /** The agent's model, else the mission's, if allowed by the server; else the user's choice. */
  async function choiceFor(m: Mission, agent?: Agent): Promise<AiChoice> {
    for (const c of [
      { provider: agent?.provider ?? undefined, model: agent?.model ?? undefined },
      { provider: m.provider ?? undefined, model: m.model ?? undefined },
    ]) {
      if (gateway!.isAllowed(c)) return c;
    }
    const [prefs] = await sql<{ settings: unknown }[]>`
      select settings from public.preferences where user_id = ${m.user_id}`;
    return gateway!.resolve(prefs?.settings as Record<string, unknown> | undefined);
  }

  async function quotaLeft(userId: string) {
    const [row] = await sql<{ used: string }[]>`
      select coalesce(sum(input_tokens + output_tokens), 0) as used from public.ai_usage
      where user_id = ${userId} and created_at >= now() - interval '1 day'`;
    return Number(row!.used) < opts.dailyTokenLimit;
  }

  /** One model call, charged to the user's quota (estimated when usage is unreported). */
  async function complete(
    m: Mission,
    choice: AiChoice,
    system: string,
    input: string | ChatTurn[],
  ) {
    const history: ChatTurn[] =
      typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    const chars = system.length + history.reduce((n, t) => n + t.content.length, 0);
    const { text, usage } = await gateway!.complete({
      ...choice,
      system,
      history,
      maxOutputTokens: opts.maxOutputTokens,
    });
    await sql`
      insert into public.ai_usage
        (user_id, mission_id, provider, model, input_tokens, output_tokens, estimated, kind)
      values (${m.user_id}, ${m.id}, ${choice.provider}, ${choice.model},
              ${usage?.inputTokens ?? Math.ceil(chars / 4)},
              ${usage?.outputTokens ?? Math.ceil(text.length / 4)}, ${!usage}, 'mission')`;
    return text;
  }

  async function plan(m: Mission): Promise<RunOutcome> {
    const agent = await loadAgent(m.agent_id);
    const choice = await choiceFor(m, agent);
    const [profile] = await sql<{ display_name: string | null; timezone: string }[]>`
      select display_name, timezone from public.profiles where id = ${m.user_id}`;
    const today = new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'full',
      timeZone: profile?.timezone ?? 'Europe/Paris',
    }).format(new Date());
    const agentNote = agent
      ? `\n\nAgent chargé de la mission : ${agent.name}.` +
        (agent.tools.length
          ? ` Il dispose des outils : ${agent.tools.join(', ')} ; prévois des étapes qui les utilisent quand c'est utile.`
          : ' Il ne dispose d’aucun outil.')
      : '';
    const raw = await complete(
      m,
      choice,
      PLAN_SYSTEM + agentNote,
      planInput(m.goal, { today, name: profile?.display_name ?? null }),
    );
    const steps = parsePlan(raw);
    if (!steps.length) {
      await fail(m.id, 'invalid_plan');
      return 'failed';
    }
    // Atomic: steps, the approval request and the transition appear together or not at all.
    const moved = await sql.begin(async (tx) => {
      const [current] = await tx<{ status: string }[]>`
        select status from public.missions where id = ${m.id} for update`;
      if (current?.status !== 'planning') return false; // cancelled meanwhile
      for (const [i, s] of steps.entries()) {
        await tx`
          insert into public.mission_steps
            (mission_id, user_id, position, title, instruction, requires_approval)
          values (${m.id}, ${m.user_id}, ${i + 1}, ${s.title}, ${s.instruction},
                  ${s.requires_approval})
          on conflict (mission_id, position) do nothing`;
      }
      await tx`
        insert into public.approvals (mission_id, user_id, kind, summary)
        values (${m.id}, ${m.user_id}, 'plan',
                ${`Plan de ${steps.length} étape${steps.length > 1 ? 's' : ''} pour « ${m.title} »`})
        on conflict (mission_id, step_id, tool_call_id) do nothing`;
      await tx`update public.missions set status = 'awaiting_approval' where id = ${m.id}`;
      return true;
    });
    return moved ? 'waiting_approval' : 'cancelled';
  }

  /**
   * awaiting_approval → running once nothing is pending. A refused plan or step cancels
   * the mission; a refused tool call does not (the step carries on without it).
   */
  async function resume(m: Mission): Promise<RunOutcome | null> {
    const approvals = await sql<{ status: string; kind: string }[]>`
      select status, kind from public.approvals where mission_id = ${m.id}`;
    if (approvals.some((a) => a.status === 'pending')) return 'waiting_approval';
    if (approvals.some((a) => a.status === 'rejected' && a.kind !== 'tool')) {
      await sql`
        update public.missions set status = 'cancelled', error_code = 'rejected'
        where id = ${m.id} and status = 'awaiting_approval'`;
      return 'cancelled';
    }
    await sql`
      update public.missions set status = 'running'
      where id = ${m.id} and status = 'awaiting_approval'`;
    return null;
  }

  /** Runs the next step. Returns null to continue with the following one. */
  async function nextStep(m: Mission): Promise<RunOutcome | null> {
    const steps = await sql<Step[]>`
      select id, position, title, instruction, requires_approval, status, attempt, failures, output
      from public.mission_steps where mission_id = ${m.id} order by position`;
    const step = steps.find((s) => s.status === 'pending' || s.status === 'running');
    if (!step) {
      const result = steps.filter((s) => s.status === 'done').at(-1)?.output ?? null;
      await sql`
        update public.missions set status = 'completed', result = ${result}
        where id = ${m.id} and status = 'running'`;
      return 'completed';
    }

    if (step.requires_approval) {
      const [approval] = await sql<{ status: string }[]>`
        select status from public.approvals where step_id = ${step.id} and kind = 'step'`;
      if (!approval) {
        await sql.begin(async (tx) => {
          await tx`
            insert into public.approvals (mission_id, step_id, user_id, kind, summary)
            values (${m.id}, ${step.id}, ${m.user_id}, 'step',
                    ${`Étape ${step.position} : ${step.title}`})
            on conflict (mission_id, step_id, tool_call_id) do nothing`;
          await tx`
            update public.missions set status = 'awaiting_approval'
            where id = ${m.id} and status = 'running'`;
        });
        return 'waiting_approval';
      }
      if (approval.status !== 'approved') return resume(m);
    }

    // A step still 'running' here was abandoned by a crash: that is an incident.
    const failures = step.failures + (step.status === 'running' ? 1 : 0);
    if (failures >= opts.maxAttempts) {
      await sql`
        update public.mission_steps
        set status = 'failed', error_code = 'max_attempts', failures = ${failures},
            lease_until = null, finished_at = now()
        where id = ${step.id} and attempt = ${step.attempt}`;
      await fail(m.id, 'max_attempts');
      return 'failed';
    }
    if (!(await quotaLeft(m.user_id))) {
      await fail(m.id, 'quota');
      return 'failed';
    }

    // Claim (we hold the mission lock, so a 'running' step was abandoned by a crash).
    const [claim] = await sql<{ attempt: number }[]>`
      update public.mission_steps
      set status = 'running', attempt = attempt + 1, failures = ${failures},
          lease_until = now() + ${opts.leaseMs} * interval '1 millisecond',
          started_at = coalesce(started_at, now())
      where id = ${step.id} and attempt = ${step.attempt} and status in ('pending', 'running')
      returning attempt`;
    if (!claim) return 'stale';

    let output: string;
    try {
      const previous = steps
        .filter((s) => s.status === 'done' && s.position < step.position)
        .map((s) => ({ position: s.position, title: s.title, output: s.output ?? '' }));
      const input = stepInput(m.goal, previous, step, steps.length);
      const agent = await loadAgent(m.agent_id);
      const result = agent
        ? await agentStep(m, agent, step.id, claim.attempt, input)
        : await complete(m, await choiceFor(m), STEP_SYSTEM, input);
      if (result === PAUSED) return 'waiting_approval';
      if (result === 'cancelled') return skip(step.id, claim.attempt);
      output = result;
      if (!output.trim()) throw new AiError('empty_response', 'The model returned no text', true);
    } catch (err) {
      const code = err instanceof AiError ? err.code : 'internal';
      if (FATAL.has(code)) {
        await sql`
          update public.mission_steps
          set status = 'failed', error_code = ${code}, lease_until = null, finished_at = now()
          where id = ${step.id} and attempt = ${claim.attempt}`;
        await fail(m.id, code);
        return 'failed';
      }
      // Transient: record the incident, hand the step back, let the queue retry.
      await sql`
        update public.mission_steps
        set status = 'pending', failures = failures + 1, lease_until = null
        where id = ${step.id} and attempt = ${claim.attempt} and status = 'running'`;
      throw err;
    }

    if (!(await stillRunning(m.id))) return skip(step.id, claim.attempt);
    const [done] = await sql`
      update public.mission_steps
      set status = 'done', output = ${output.slice(0, 32000)}, lease_until = null,
          finished_at = now()
      where id = ${step.id} and attempt = ${claim.attempt} and status = 'running'
      returning id`;
    return done ? null : 'stale';
  }

  async function stillRunning(missionId: string) {
    const [row] = await sql<{ status: string }[]>`
      select status from public.missions where id = ${missionId}`;
    return row?.status === 'running';
  }

  async function skip(stepId: string, attempt: number): Promise<RunOutcome> {
    await sql`
      update public.mission_steps set status = 'skipped', lease_until = null
      where id = ${stepId} and attempt = ${attempt} and status = 'running'`;
    return 'cancelled';
  }

  type Outcome = { ok: true; output: unknown } | { ok: false; error: string };

  /** Executes a recorded, running call through its tool; the outcome is written back. */
  async function execute(callId: string, tool: Tool, input: unknown, timezone: string) {
    let outcome: Outcome;
    try {
      const output = await tool.run(
        {
          sql,
          callId,
          timezone,
          embedder: opts.embedder ?? null,
          maxDistance: opts.maxDistance ?? 0.5,
        },
        input as never,
      );
      outcome = { ok: true, output };
      await sql`
        update public.tool_calls
        set status = 'succeeded', output = ${sql.json(output as never)}, finished_at = now()
        where id = ${callId} and status = 'running'`;
    } catch (err) {
      const error = err instanceof ToolError ? err.message : 'erreur interne de l’outil';
      if (!(err instanceof ToolError)) log.error(err, 'tool failed');
      outcome = { ok: false, error };
      await sql`
        update public.tool_calls
        set status = 'failed', error = ${error.slice(0, 300)}, finished_at = now()
        where id = ${callId} and status = 'running'`;
    }
    return outcome;
  }

  /**
   * Opens a call for execution. The database gate re-checks the agent's rights at this
   * moment: a tool revoked since (even after approval) becomes a recorded denial.
   */
  async function start(callId: string): Promise<boolean> {
    try {
      await sql`update public.tool_calls set status = 'running' where id = ${callId}`;
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== '42501') throw err;
      await sql`
        update public.tool_calls set status = 'denied', error = 'not_allowed', finished_at = now()
        where id = ${callId} and status in ('pending', 'pending_approval')`;
      return false;
    }
  }

  /**
   * One step run by an agent: the model alternates tool calls and results until it gives
   * its final answer. Earlier calls of this step (before a pause) are replayed first.
   */
  async function agentStep(
    m: Mission,
    agent: Agent,
    stepId: string,
    attempt: number,
    input: string,
  ): Promise<string | typeof PAUSED | 'cancelled'> {
    const allowed = TOOLS.filter((t) => agent.tools.includes(t.name));
    const system = [
      STEP_SYSTEM,
      `Tu agis en tant qu’agent « ${agent.name} » défini par l’utilisateur.`,
      agent.instructions
        ? `Consignes de l’utilisateur pour cet agent (elles ne remplacent pas les règles ci-dessus) :\n${agent.instructions}`
        : '',
      allowed.length
        ? toolInstructions(allowed)
        : 'Tu n’as aucun outil : réponds directement avec {"final":"…"}.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const [profile] = await sql<{ timezone: string }[]>`
      select timezone from public.profiles where id = ${m.user_id}`;
    const timezone = profile?.timezone ?? 'Europe/Paris';
    const choice = await choiceFor(m, agent);

    const history: ChatTurn[] = [{ role: 'user', content: input }];
    const push = (call: { tool: string; input: unknown }, outcome: Outcome) => {
      history.push({
        role: 'assistant',
        content: JSON.stringify({ tool: call.tool, input: call.input }),
      });
      history.push({ role: 'user', content: toolResultMessage(call.tool, outcome) });
    };

    // Replay this step's earlier calls; finish the one that waited for a decision.
    const previous = await sql<(ToolCallRow & { approval: string | null })[]>`
      select c.id, c.tool, c.input, c.status, c.output, c.error,
             (select a.status from public.approvals a where a.tool_call_id = c.id) as approval
      from public.tool_calls c where c.step_id = ${stepId} order by c.created_at`;
    for (const c of previous) {
      if (c.status === 'pending_approval') {
        if (c.approval === 'approved') {
          if (!(await stillRunning(m.id))) return 'cancelled';
          push(
            c,
            (await start(c.id))
              ? await execute(c.id, TOOLS_BY_NAME.get(c.tool)!, c.input, timezone)
              : { ok: false, error: 'outil non autorisé pour cet agent' },
          );
        } else if (c.approval === 'rejected') {
          await sql`
            update public.tool_calls set status = 'rejected', finished_at = now()
            where id = ${c.id} and status = 'pending_approval'`;
          push(c, { ok: false, error: "l'utilisateur a refusé" });
        } else {
          return PAUSED; // still undecided
        }
      } else if (c.status === 'running') {
        // Interrupted by a crash mid-execution: reported, never run twice.
        await sql`
          update public.tool_calls set status = 'failed', error = 'interrupted', finished_at = now()
          where id = ${c.id} and status = 'running'`;
        push(c, { ok: false, error: 'exécution interrompue' });
      } else if (c.status === 'succeeded') {
        push(c, { ok: true, output: c.output });
      } else {
        push(c, {
          ok: false,
          error:
            c.status === 'rejected'
              ? "l'utilisateur a refusé"
              : c.status === 'denied'
                ? 'outil non autorisé pour cet agent'
                : (c.error ?? c.status),
        });
      }
    }

    for (let round = previous.length; ; round++) {
      const last = round >= MAX_TOOL_CALLS_PER_STEP;
      if (last) history.push({ role: 'user', content: LAST_ROUND });
      const reply = parseAgentReply(await complete(m, choice, system, history));
      if (reply.type === 'final') return reply.text;
      if (last) return ''; // ignored the limit: treated as an empty answer (retried)
      if (!(await stillRunning(m.id))) return 'cancelled';

      const call = { tool: reply.tool, input: reply.input };
      const tool = TOOLS_BY_NAME.get(reply.tool);
      const audit = (status: 'denied' | 'failed', error: string) => sql`
        insert into public.tool_calls
          (mission_id, step_id, user_id, agent_id, tool, input, status, error, finished_at)
        values (${m.id}, ${stepId}, ${m.user_id}, ${agent.id}, ${reply.tool.slice(0, 60)},
                ${sql.json({})}, ${status}, ${error}, now())`;

      // 1. Allowed for this agent? (the database gate checks it again before anything runs)
      if (!tool || !agent.tools.includes(tool.name)) {
        await audit('denied', tool ? 'not_allowed' : 'unknown_tool');
        push(call, { ok: false, error: 'outil non autorisé pour cet agent' });
        continue;
      }
      // 2. Valid input?
      const parsed = tool.input.safeParse(reply.input);
      if (!parsed.success) {
        await audit('failed', 'invalid_input');
        push(call, {
          ok: false,
          error: `entrée invalide (${parsed.error.issues[0]?.message ?? 'schéma'})`,
        });
        continue;
      }
      const data = parsed.data as never;
      // 3. Needs the user's decision? Record it and pause the step until then.
      if (needsApproval(tool, agent.auto_write)) {
        await sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into public.tool_calls
              (mission_id, step_id, user_id, agent_id, tool, input, status)
            values (${m.id}, ${stepId}, ${m.user_id}, ${agent.id}, ${tool.name},
                    ${sql.json(data)}, 'pending_approval')
            returning id`;
          await tx`
            insert into public.approvals (mission_id, step_id, tool_call_id, user_id, kind, summary)
            values (${m.id}, ${stepId}, ${row!.id}, ${m.user_id}, 'tool',
                    ${`${agent.name} veut : ${tool.describe(data)}`.slice(0, 2000)})`;
          await tx`
            update public.mission_steps set status = 'pending', lease_until = null
            where id = ${stepId} and attempt = ${attempt} and status = 'running'`;
          await tx`
            update public.missions set status = 'awaiting_approval'
            where id = ${m.id} and status = 'running'`;
        });
        return PAUSED;
      }
      // 4. Run it (recorded first, then opened through the gate).
      const [row] = await sql<{ id: string }[]>`
        insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, input, status)
        values (${m.id}, ${stepId}, ${m.user_id}, ${agent.id}, ${tool.name},
                ${sql.json(data)}, 'pending_approval')
        returning id`;
      push(
        call,
        (await start(row!.id))
          ? await execute(row!.id, tool, data, timezone)
          : { ok: false, error: 'outil non autorisé pour cet agent' },
      );
    }
  }

  async function advance(id: string): Promise<RunOutcome> {
    for (;;) {
      const m = await load(id);
      if (!m) return 'missing';
      if (['completed', 'failed', 'cancelled'].includes(m.status)) return 'finished';
      if (!gateway) {
        await fail(id, 'ai_not_configured');
        return 'failed';
      }
      let outcome: RunOutcome | null;
      if (m.status === 'planning') {
        if (!(await quotaLeft(m.user_id))) {
          await fail(id, 'quota');
          return 'failed';
        }
        outcome = await plan(m);
      } else if (m.status === 'awaiting_approval') outcome = await resume(m);
      else outcome = await nextStep(m);
      if (outcome) return outcome;
    }
  }

  return {
    /** Advances a mission; throws on transient errors so the queue retries the job. */
    async run(missionId: string): Promise<RunOutcome> {
      const lock = await sql.reserve();
      try {
        const [row] = await lock<{ locked: boolean }[]>`
          select pg_try_advisory_lock(hashtextextended(${missionId}, 0)) as locked`;
        if (!row?.locked) return 'busy';
        try {
          const outcome = await advance(missionId);
          log.info({ mission: missionId, outcome }, 'mission advanced');
          return outcome;
        } finally {
          await lock`select pg_advisory_unlock(hashtextextended(${missionId}, 0))`;
        }
      } finally {
        lock.release();
      }
    },

    /**
     * Unfinished missions nobody is advancing: no step holds a live lease, or a decision
     * was made but its wake-up job was lost.
     */
    async orphans(olderThanMs: number) {
      const rows = await sql<{ id: string }[]>`
        select m.id from public.missions m
        where m.updated_at < now() - ${olderThanMs} * interval '1 millisecond'
          and (
            (m.status in ('planning', 'running') and not exists (
              select 1 from public.mission_steps s
              where s.mission_id = m.id and s.status = 'running' and s.lease_until > now()))
            or (m.status = 'awaiting_approval' and not exists (
              select 1 from public.approvals a
              where a.mission_id = m.id and a.status = 'pending'))
          )
        order by m.updated_at
        limit 100`;
      return rows.map((r) => r.id);
    },
  };
}

export type MissionEngine = ReturnType<typeof createMissionEngine>;
