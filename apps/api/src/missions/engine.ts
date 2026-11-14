import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import type { AiChoice, Gateway } from '../ai/gateway.js';
import { AiError, type ProviderId } from '../ai/types.js';
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
 *   - bounded retries: a step claimed MISSION_MAX_ATTEMPTS times fails the mission;
 *   - every state change goes through the SQL state machine and lands in `activity`.
 */
export type EngineOptions = {
  sql: Sql;
  gateway: Gateway | null;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  leaseMs: number;
  maxAttempts: number;
  dailyTokenLimit: number;
  maxOutputTokens: number;
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
};
type Step = {
  id: string;
  position: number;
  title: string;
  instruction: string;
  requires_approval: boolean;
  status: string;
  attempt: number;
  output: string | null;
};

/** Errors that will not get better by retrying: the mission fails right away. */
const FATAL = new Set(['invalid_request', 'model_not_found', 'payment_required', 'auth']);

export function createMissionEngine(opts: EngineOptions) {
  const { sql, gateway, log } = opts;

  const load = async (id: string) =>
    (
      await sql<Mission[]>`
        select id, user_id, goal, title, status, provider, model
        from public.missions where id = ${id}`
    )[0];

  const fail = (id: string, code: string) => sql`
    update public.missions set status = 'failed', error_code = ${code.slice(0, 32)}
    where id = ${id} and status in ('planning', 'awaiting_approval', 'running')`;

  /** The mission's model if still allowed by the server, else the user's current choice. */
  async function choiceFor(m: Mission): Promise<AiChoice> {
    const choice = { provider: m.provider ?? undefined, model: m.model ?? undefined };
    if (gateway!.isAllowed(choice)) return choice;
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
  async function complete(m: Mission, choice: AiChoice, system: string, input: string) {
    const { text, usage } = await gateway!.complete({
      ...choice,
      system,
      history: [{ role: 'user', content: input }],
      maxOutputTokens: opts.maxOutputTokens,
    });
    await sql`
      insert into public.ai_usage
        (user_id, mission_id, provider, model, input_tokens, output_tokens, estimated, kind)
      values (${m.user_id}, ${m.id}, ${choice.provider}, ${choice.model},
              ${usage?.inputTokens ?? Math.ceil((system.length + input.length) / 4)},
              ${usage?.outputTokens ?? Math.ceil(text.length / 4)}, ${!usage}, 'mission')`;
    return text;
  }

  async function plan(m: Mission): Promise<RunOutcome> {
    const choice = await choiceFor(m);
    const [profile] = await sql<{ display_name: string | null; timezone: string }[]>`
      select display_name, timezone from public.profiles where id = ${m.user_id}`;
    const today = new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'full',
      timeZone: profile?.timezone ?? 'Europe/Paris',
    }).format(new Date());
    const raw = await complete(
      m,
      choice,
      PLAN_SYSTEM,
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
        on conflict (mission_id, step_id) do nothing`;
      await tx`update public.missions set status = 'awaiting_approval' where id = ${m.id}`;
      return true;
    });
    return moved ? 'waiting_approval' : 'cancelled';
  }

  /** awaiting_approval → running once every requested approval is granted. */
  async function resume(m: Mission): Promise<RunOutcome | null> {
    const approvals = await sql<{ status: string }[]>`
      select status from public.approvals where mission_id = ${m.id}`;
    if (approvals.some((a) => a.status === 'pending')) return 'waiting_approval';
    if (approvals.some((a) => a.status === 'rejected')) {
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
      select id, position, title, instruction, requires_approval, status, attempt, output
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
        select status from public.approvals where step_id = ${step.id}`;
      if (!approval) {
        await sql.begin(async (tx) => {
          await tx`
            insert into public.approvals (mission_id, step_id, user_id, kind, summary)
            values (${m.id}, ${step.id}, ${m.user_id}, 'step',
                    ${`Étape ${step.position} : ${step.title}`})
            on conflict (mission_id, step_id) do nothing`;
          await tx`
            update public.missions set status = 'awaiting_approval'
            where id = ${m.id} and status = 'running'`;
        });
        return 'waiting_approval';
      }
      if (approval.status !== 'approved') return resume(m);
    }

    if (step.attempt >= opts.maxAttempts) {
      await sql`
        update public.mission_steps
        set status = 'failed', error_code = 'max_attempts', lease_until = null, finished_at = now()
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
      set status = 'running', attempt = attempt + 1,
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
      output = await complete(
        m,
        await choiceFor(m),
        STEP_SYSTEM,
        stepInput(m.goal, previous, step, steps.length),
      );
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
      throw err; // transient: the queue retries, the next claim counts as a new attempt
    }

    const [mission] = await sql<{ status: string }[]>`
      select status from public.missions where id = ${m.id}`;
    if (mission?.status !== 'running') {
      await sql`
        update public.mission_steps set status = 'skipped', lease_until = null
        where id = ${step.id} and attempt = ${claim.attempt} and status = 'running'`;
      return 'cancelled';
    }
    const [done] = await sql`
      update public.mission_steps
      set status = 'done', output = ${output.slice(0, 32000)}, lease_until = null,
          finished_at = now()
      where id = ${step.id} and attempt = ${claim.attempt} and status = 'running'
      returning id`;
    return done ? null : 'stale';
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
