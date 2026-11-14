-- Phase 5: missions (multi-step goals run by a background worker), human approvals,
-- an activity log and notifications.
--
-- Who writes what:
--   * users (JWT, RLS): create a mission, cancel it, decide a pending approval, mark a
--     notification read. Nothing else.
--   * the worker (role `leana_worker`, see below): plans, runs steps, requests approvals.
--   * triggers only: activity and notifications, derived from state changes, so the log
--     is an audit trail nobody can forge or edit.

-- ---------------------------------------------------------------- worker role
-- No login and no BYPASSRLS: the worker connects with its own login role that is a member
-- of this one (production) or as `postgres` then `SET ROLE leana_worker` (local), and only
-- gets the grants and policies below. It never touches auth, memories or conversations.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'leana_worker') then
    create role leana_worker nologin;
  end if;
end;
$$;
grant usage on schema public to leana_worker;
-- Lets an admin connection (local dev: `postgres`) drop to the worker's rights.
grant leana_worker to postgres;

-- ---------------------------------------------------------------- tables

create table public.missions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  goal text not null check (char_length(btrim(goal)) between 1 and 4000),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  status text not null default 'planning'
    check (status in ('planning', 'awaiting_approval', 'running', 'completed', 'failed', 'cancelled')),
  -- Chosen by the API at creation; the worker re-checks it against the server allowlist.
  provider text check (provider in ('gemini', 'openrouter')),
  model text check (char_length(model) <= 100),
  result text check (char_length(result) <= 32000),
  error_code text check (char_length(error_code) <= 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index missions_user_recent_idx on public.missions (user_id, created_at desc);
create index missions_workspace_idx on public.missions (workspace_id);
-- The worker's recovery sweep looks for unfinished missions.
create index missions_open_idx on public.missions (updated_at)
  where status in ('planning', 'running');

create table public.mission_steps (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  position smallint not null check (position between 1 and 20),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  instruction text not null check (char_length(btrim(instruction)) between 1 and 2000),
  requires_approval boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  -- Fencing: a worker may only finish the attempt it claimed, while its lease holds.
  attempt smallint not null default 0 check (attempt between 0 and 10),
  lease_until timestamptz,
  output text check (char_length(output) <= 32000),
  error_code text check (char_length(error_code) <= 32),
  started_at timestamptz,
  finished_at timestamptz,
  unique (mission_id, position)
);
create index mission_steps_user_idx on public.mission_steps (user_id);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions (id) on delete cascade,
  step_id uuid references public.mission_steps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('plan', 'step')),
  summary text not null check (char_length(summary) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'plan') = (step_id is null)),
  check ((status = 'pending') = (decided_at is null)),
  -- One approval for the plan, one per step: retries never ask twice.
  unique nulls not distinct (mission_id, step_id)
);
create index approvals_user_pending_idx on public.approvals (user_id, created_at desc)
  where status = 'pending';
create index approvals_step_idx on public.approvals (step_id);

create table public.activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  mission_id uuid references public.missions (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 40),
  summary text not null check (char_length(summary) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);
create index activity_user_recent_idx on public.activity (user_id, created_at desc);
create index activity_mission_idx on public.activity (mission_id);
create index activity_workspace_idx on public.activity (workspace_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  activity_id uuid not null references public.activity (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  -- Internal path only (the UI navigates with it): no open redirect through notifications.
  link text check (link ~ '^/[a-z0-9/_-]*$'),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_recent_idx on public.notifications (user_id, created_at desc);
create index notifications_activity_idx on public.notifications (activity_id);

-- Missions in the usage ledger.
alter table public.ai_usage
  add column mission_id uuid references public.missions (id) on delete set null,
  drop constraint ai_usage_kind_check,
  add constraint ai_usage_kind_check
    check (kind in ('chat', 'memory', 'summary', 'embedding', 'mission'));
create index ai_usage_mission_idx on public.ai_usage (mission_id);

-- ---------------------------------------------------------------- state machine

create function private.mission_transition() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  if new.status = old.status then
    return new;
  end if;
  -- Users can only stop their mission; everything else is the worker's job.
  if current_user = 'authenticated' and new.status <> 'cancelled' then
    raise exception 'Only cancellation is allowed' using errcode = '42501';
  end if;
  if not (
    (old.status = 'planning' and new.status in ('awaiting_approval', 'failed', 'cancelled'))
    or (old.status = 'awaiting_approval' and new.status in ('running', 'failed', 'cancelled'))
    or (old.status = 'running' and new.status in ('awaiting_approval', 'completed', 'failed', 'cancelled'))
  ) then
    raise exception 'Invalid mission transition % -> %', old.status, new.status
      using errcode = '23514';
  end if;
  if new.status in ('completed', 'failed', 'cancelled') then
    new.finished_at := now();
  end if;
  return new;
end;
$$;
create trigger missions_transition before update on public.missions
  for each row execute function private.mission_transition();

-- A decision is final, made once, by the owner, on a mission still waiting for it.
create function private.approval_decision() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.status <> 'pending' then
    raise exception 'This approval was already decided' using errcode = '23514';
  end if;
  if new.status not in ('approved', 'rejected') then
    raise exception 'Decide with approved or rejected' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.missions m
    where m.id = new.mission_id and m.status = 'awaiting_approval'
  ) then
    raise exception 'This mission is not waiting for a decision' using errcode = '23514';
  end if;
  new.decided_at := now();
  return new;
end;
$$;
create trigger approvals_decision before update of status on public.approvals
  for each row execute function private.approval_decision();

-- Steps and approvals belong to their mission's owner.
create function private.check_mission_child() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.missions m where m.id = new.mission_id and m.user_id = new.user_id
  ) then
    raise exception 'user_id must be the mission owner' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger mission_steps_owner before insert on public.mission_steps
  for each row execute function private.check_mission_child();
create trigger approvals_owner before insert on public.approvals
  for each row execute function private.check_mission_child();

-- ---------------------------------------------------------------- activity + notifications
-- security definer: nobody holds insert rights on these tables.

create function private.log_activity(
  p_user uuid, p_mission uuid, p_kind text, p_summary text,
  p_notify text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  act_id uuid;
begin
  insert into public.activity (user_id, workspace_id, mission_id, kind, summary)
  select p_user, m.workspace_id, p_mission, p_kind, left(p_summary, 500)
  from public.missions m where m.id = p_mission
  returning id into act_id;
  if p_notify is not null and act_id is not null then
    insert into public.notifications (user_id, activity_id, title, link)
    values (p_user, act_id, left(p_notify, 200), '/missions/' || p_mission);
  end if;
end;
$$;
revoke execute on function private.log_activity from public;

create function private.on_mission_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.user_id, new.id, 'mission.created',
      'Mission créée : ' || new.title);
  elsif new.status is distinct from old.status then
    case new.status
      when 'completed' then
        perform private.log_activity(new.user_id, new.id, 'mission.completed',
          'Mission terminée : ' || new.title, 'Mission terminée : ' || new.title);
      when 'failed' then
        perform private.log_activity(new.user_id, new.id, 'mission.failed',
          'Mission en échec : ' || new.title || coalesce(' (' || new.error_code || ')', ''),
          'Mission en échec : ' || new.title);
      when 'cancelled' then
        perform private.log_activity(new.user_id, new.id, 'mission.cancelled',
          'Mission annulée : ' || new.title);
      else null;
    end case;
  end if;
  return null;
end;
$$;
create trigger missions_activity after insert or update of status on public.missions
  for each row execute function private.on_mission_change();

create function private.on_approval_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.user_id, new.mission_id, 'approval.requested',
      'Validation demandée : ' || new.summary, 'Validation demandée : ' || new.summary);
  elsif new.status is distinct from old.status then
    perform private.log_activity(new.user_id, new.mission_id, 'approval.' || new.status,
      case new.status when 'approved' then 'Validé : ' else 'Refusé : ' end || new.summary);
  end if;
  return null;
end;
$$;
create trigger approvals_activity after insert or update of status on public.approvals
  for each row execute function private.on_approval_change();

create function private.on_step_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'running' and new.attempt > 1 and new.attempt is distinct from old.attempt then
    perform private.log_activity(new.user_id, new.mission_id, 'step.retried',
      'Étape ' || new.position || ' reprise (tentative ' || new.attempt || ') : ' || new.title);
  elsif new.status is distinct from old.status and new.status in ('done', 'failed') then
    perform private.log_activity(new.user_id, new.mission_id, 'step.' || new.status,
      case new.status when 'done' then 'Étape ' else 'Étape en échec ' end
        || new.position || ' : ' || new.title);
  end if;
  return null;
end;
$$;
create trigger mission_steps_activity after update on public.mission_steps
  for each row execute function private.on_step_change();

-- ---------------------------------------------------------------- RLS + grants

alter table public.missions enable row level security;
alter table public.mission_steps enable row level security;
alter table public.approvals enable row level security;
alter table public.activity enable row level security;
alter table public.notifications enable row level security;

revoke all on public.missions, public.mission_steps, public.approvals, public.activity,
  public.notifications from anon, authenticated, leana_worker;

-- users
grant select, insert (workspace_id, goal, title, provider, model), update (status)
  on public.missions to authenticated;
create policy "missions: read own" on public.missions for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "missions: create own" on public.missions for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "missions: cancel own" on public.missions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select on public.mission_steps to authenticated;
create policy "mission_steps: read own" on public.mission_steps for select to authenticated
  using (user_id = (select auth.uid()));

grant select, update (status) on public.approvals to authenticated;
create policy "approvals: read own" on public.approvals for select to authenticated
  using (user_id = (select auth.uid()));
create policy "approvals: decide own" on public.approvals for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select on public.activity to authenticated;
create policy "activity: read own" on public.activity for select to authenticated
  using (user_id = (select auth.uid()));

grant select, update (read_at) on public.notifications to authenticated;
create policy "notifications: read own" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "notifications: mark own" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- worker: every user's missions, but only the columns it drives.
grant select, update (status, result, error_code) on public.missions to leana_worker;
create policy "missions: worker" on public.missions for all to leana_worker
  using (true) with check (true);
grant select,
      insert (mission_id, user_id, position, title, instruction, requires_approval),
      update (status, attempt, lease_until, output, error_code, started_at, finished_at)
  on public.mission_steps to leana_worker;
create policy "mission_steps: worker" on public.mission_steps for all to leana_worker
  using (true) with check (true);
grant select, insert (mission_id, step_id, user_id, kind, summary)
  on public.approvals to leana_worker;
create policy "approvals: worker" on public.approvals for all to leana_worker
  using (true) with check (true);

-- What a step needs to run as the user: their profile, AI preference and quota ledger.
grant select (id, display_name, locale, timezone) on public.profiles to leana_worker;
create policy "profiles: worker reads" on public.profiles for select to leana_worker using (true);
grant select (user_id, settings) on public.preferences to leana_worker;
create policy "preferences: worker reads" on public.preferences for select to leana_worker
  using (true);
grant select, insert on public.ai_usage to leana_worker;
create policy "ai_usage: worker" on public.ai_usage for all to leana_worker
  using (true) with check (true);

