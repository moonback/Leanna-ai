-- Phase 6: Agent Studio and the typed tool registry.
--
-- Permission model, enforced here and not only in the API/worker code:
--   * `tools` is the catalog of what exists (mirrors the code registry, checked by a test);
--   * an agent lists the tools it may use; a mission may run with one agent;
--   * a tool call is accepted only if its tool is in the mission agent's list, and a
--     write tool only after an approved approval (unless the agent may write on its own),
--     a sensitive tool always after an approved approval;
--   * the worker reaches user data only through `private.tool_*` functions, which act
--     solely for a tool call that is currently running, on that call's user.

-- ---------------------------------------------------------------- catalog

create table public.tools (
  name text primary key check (name ~ '^[a-z]+\.[a-z_]+$'),
  -- read: no side effect; write: changes the user's own LEANA data; sensitive: acts
  -- outside LEANA or cannot be undone (Phase 8 connectors) and always needs approval.
  risk text not null check (risk in ('read', 'write', 'sensitive')),
  label text not null check (char_length(label) between 1 and 80),
  description text not null check (char_length(description) between 1 and 500)
);
insert into public.tools (name, risk, label, description) values
  ('clock.now', 'read', 'Date et heure',
   'Date et heure actuelles dans le fuseau horaire de l''utilisateur.'),
  ('math.calculate', 'read', 'Calculatrice',
   'Évalue une expression arithmétique (+ - * / % ^, parenthèses, décimales).'),
  ('memory.search', 'read', 'Chercher dans la mémoire',
   'Recherche hybride (mots-clés et sens) dans les souvenirs actifs de l''utilisateur.'),
  ('memory.remember', 'write', 'Retenir',
   'Ajoute un souvenir durable sur l''utilisateur.'),
  ('memory.forget', 'write', 'Oublier',
   'Archive un souvenir (restaurable depuis la page Mémoire).');

-- ---------------------------------------------------------------- agents

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text check (char_length(description) <= 300),
  -- Added to the system prompt as the agent's role; never overrides LEANA's safety rules.
  instructions text not null default '' check (char_length(instructions) <= 4000),
  tools text[] not null default '{}' check (cardinality(tools) <= 20),
  -- Write tools without asking (sensitive tools always ask, whatever this says).
  auto_write boolean not null default false,
  provider text check (provider in ('gemini', 'openrouter')),
  model text check (char_length(model) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((provider is null) or (model is not null))
);
create index agents_user_idx on public.agents (user_id, updated_at desc);
create index agents_workspace_idx on public.agents (workspace_id);
create trigger agents_updated_at before update on public.agents
  for each row execute function private.set_updated_at();

-- Every listed tool must exist; duplicates are dropped.
create function private.check_agent_tools() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  unknown text;
begin
  select t into unknown from unnest(new.tools) t
  where not exists (select 1 from public.tools x where x.name = t) limit 1;
  if unknown is not null then
    raise exception 'Unknown tool: %', unknown using errcode = '23514';
  end if;
  new.tools := array(select distinct t from unnest(new.tools) t order by t);
  return new;
end;
$$;
create trigger agents_check_tools before insert or update of tools on public.agents
  for each row execute function private.check_agent_tools();

alter table public.missions
  add column agent_id uuid references public.agents (id) on delete set null;
create index missions_agent_idx on public.missions (agent_id);

-- A mission may only use the caller's own agent (foreign keys bypass RLS; this does not).
create function private.check_mission_agent() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.agent_id is not null and not exists (
    select 1 from public.agents a where a.id = new.agent_id and a.user_id = new.user_id
  ) then
    raise exception 'agent_id must be one of your own agents' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger missions_check_agent before insert on public.missions
  for each row execute function private.check_mission_agent();

-- ---------------------------------------------------------------- steps: failures

-- `attempt` counts claims (fencing); `failures` counts incidents (crash, outage) and is
-- what ends a step. Pausing a step for a tool approval is neither.
alter table public.mission_steps
  add column failures smallint not null default 0 check (failures between 0 and 10);
grant update (failures) on public.mission_steps to leana_worker;

create or replace function private.on_step_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.failures > old.failures and new.status <> 'failed' then
    perform private.log_activity(new.user_id, new.mission_id, 'step.retried',
      'Étape ' || new.position || ' reprise après incident (' || new.failures || ') : ' || new.title);
  end if;
  if new.status is distinct from old.status and new.status in ('done', 'failed') then
    perform private.log_activity(new.user_id, new.mission_id, 'step.' || new.status,
      case new.status when 'done' then 'Étape ' else 'Étape en échec ' end
        || new.position || ' : ' || new.title);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------- tool calls

create table public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions (id) on delete cascade,
  step_id uuid not null references public.mission_steps (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  tool text not null check (char_length(tool) between 1 and 60),
  input jsonb not null default '{}' check (octet_length(input::text) <= 16384),
  -- denied: not allowed for this agent (kept as an audit record, never executed).
  status text not null
    check (status in ('denied', 'pending_approval', 'rejected', 'running', 'succeeded', 'failed')),
  output jsonb check (octet_length(output::text) <= 16384),
  error text check (char_length(error) <= 300),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
create index tool_calls_step_idx on public.tool_calls (step_id, created_at);
create index tool_calls_mission_idx on public.tool_calls (mission_id);
create index tool_calls_user_idx on public.tool_calls (user_id);
create index tool_calls_agent_idx on public.tool_calls (agent_id);

alter table public.approvals
  add column tool_call_id uuid references public.tool_calls (id) on delete cascade,
  drop constraint approvals_kind_check,
  add constraint approvals_kind_check check (kind in ('plan', 'step', 'tool')),
  add constraint approvals_tool_call_check check ((kind = 'tool') = (tool_call_id is not null)),
  drop constraint approvals_mission_id_step_id_key,
  add constraint approvals_target_key unique nulls not distinct (mission_id, step_id, tool_call_id);
create index approvals_tool_call_idx on public.approvals (tool_call_id);

/*
  The permission gate. Runs as the caller (the worker) with RLS, on every insert and on
  every status change:
    - the call belongs to the mission's owner and to a running step of that mission;
    - the agent recorded is the mission's agent;
    - to run, the tool must be in that agent's list right now (revoking a tool takes
      effect at the next call), and approval rules must be met.
*/
create function private.check_tool_call() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  m record;
  t record;
  a record;
begin
  if tg_op = 'UPDATE' and new.status = old.status then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('denied', 'rejected', 'succeeded', 'failed') then
    raise exception 'A finished tool call is final' using errcode = '23514';
  end if;

  select mi.user_id, mi.agent_id, mi.status into m from public.missions mi where mi.id = new.mission_id;
  if m is null or m.user_id <> new.user_id then
    raise exception 'user_id must be the mission owner' using errcode = '23514';
  end if;
  if new.agent_id is distinct from m.agent_id then
    raise exception 'agent_id must be the mission agent' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and not exists (
    select 1 from public.mission_steps s
    where s.id = new.step_id and s.mission_id = new.mission_id and s.status = 'running'
  ) then
    raise exception 'Tool calls happen inside a running step' using errcode = '23514';
  end if;

  if new.status in ('denied', 'rejected', 'failed', 'succeeded') then
    return new; -- audit records and outcomes; running/approval are what open access
  end if;

  select x.risk into t from public.tools x where x.name = new.tool;
  select ag.tools, ag.auto_write into a from public.agents ag where ag.id = new.agent_id;
  if t is null or a is null or not (new.tool = any (a.tools)) then
    raise exception 'Tool % is not allowed for this agent', new.tool using errcode = '42501';
  end if;
  if new.status = 'running' and (t.risk = 'sensitive' or (t.risk = 'write' and not a.auto_write))
     and not exists (
       select 1 from public.approvals ap
       where ap.tool_call_id = new.id and ap.status = 'approved'
     ) then
    raise exception 'Tool % needs an approved approval', new.tool using errcode = '42501';
  end if;
  if new.status = 'running' and m.status <> 'running' then
    raise exception 'The mission is not running' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tool_calls_gate before insert or update of status on public.tool_calls
  for each row execute function private.check_tool_call();

-- Audit: denials and approved writes are visible in the activity log.
create function private.on_tool_call_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'denied' and (tg_op = 'INSERT' or old.status <> 'denied') then
    perform private.log_activity(new.user_id, new.mission_id, 'tool.denied',
      'Outil refusé (non autorisé pour l''agent) : ' || new.tool);
  elsif new.status = 'succeeded' and tg_op = 'UPDATE' and old.status <> 'succeeded'
        and (select risk from public.tools where name = new.tool) <> 'read' then
    perform private.log_activity(new.user_id, new.mission_id, 'tool.used',
      'Outil utilisé : ' || new.tool);
  end if;
  return null;
end;
$$;
create trigger tool_calls_activity after insert or update of status on public.tool_calls
  for each row execute function private.on_tool_call_change();

-- ---------------------------------------------------------------- memory tools
-- Core recall with an explicit user, so tools and the API share one implementation.

create function private.match_memories_for(
  uid uuid,
  query_text text,
  query_embedding extensions.vector(768),
  embedding_model text,
  match_count integer,
  max_distance double precision,
  workspace uuid
)
returns table (
  id uuid, kind text, content text, importance smallint, source text,
  created_at timestamptz, updated_at timestamptz, score double precision,
  lexical_rank integer, semantic_rank integer, distance double precision
)
language sql stable security invoker set search_path = '' as $$
  with params as (
    select private.memory_query(query_text) as q,
           least(greatest(coalesce(match_count, 8), 1), 50) as n
  ),
  lexical as (
    select m.id,
           row_number() over (
             order by pg_catalog.ts_rank_cd(m.fts, p.q) desc, m.importance desc, m.updated_at desc
           )::integer as rank
    from public.memories m, params p
    where m.user_id = uid and m.status = 'active'
      and (workspace is null or m.workspace_id = workspace)
      and m.fts @@ p.q
    order by rank
    limit (select n * 4 from params)
  ),
  semantic as (
    select m.id,
           (m.embedding operator(extensions.<=>) query_embedding) as distance,
           row_number() over (
             order by m.embedding operator(extensions.<=>) query_embedding
           )::integer as rank
    from public.memories m
    where query_embedding is not null and m.user_id = uid and m.status = 'active'
      and (workspace is null or m.workspace_id = workspace)
      and m.embedding_model = match_memories_for.embedding_model
      and (m.embedding operator(extensions.<=>) query_embedding) <= max_distance
    order by rank
    limit (select n * 4 from params)
  )
  select m.id, m.kind, m.content, m.importance, m.source, m.created_at, m.updated_at,
         coalesce(1.0 / (60 + l.rank), 0) + coalesce(1.0 / (60 + s.rank), 0) as score,
         l.rank, s.rank, s.distance
  from lexical l
  full join semantic s on s.id = l.id
  join public.memories m on m.id = coalesce(l.id, s.id)
  order by score desc, m.importance desc, m.updated_at desc
  limit (select n from params);
$$;
revoke execute on function private.match_memories_for from public;
grant execute on function private.match_memories_for to authenticated;

create or replace function public.match_memories(
  query_text text,
  query_embedding extensions.vector(768) default null,
  embedding_model text default null,
  match_count integer default 8,
  max_distance double precision default 0.5,
  workspace uuid default null
)
returns table (
  id uuid, kind text, content text, importance smallint, source text,
  created_at timestamptz, updated_at timestamptz, score double precision,
  lexical_rank integer, semantic_rank integer, distance double precision
)
language sql stable security invoker set search_path = '' as $$
  select * from private.match_memories_for((select auth.uid()), query_text, query_embedding,
    embedding_model, match_count, max_distance, workspace);
$$;

alter table public.memories drop constraint memories_source_check,
  add constraint memories_source_check check (source in ('manual', 'conversation', 'agent'));

-- The tool call that grants access: running, of the expected tool. Returns its user.
create function private.tool_call_user(p_call uuid, p_tool text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.user_id from public.tool_calls c
  where c.id = p_call and c.tool = p_tool and c.status = 'running';
$$;
revoke execute on function private.tool_call_user from public;

-- Vectors arrive as text ('[0.1,…]') and are cast here: the worker needs no access to the
-- `extensions` schema.
create function private.tool_memory_search(
  p_call uuid, p_query text, p_embedding text, p_model text,
  p_count integer, p_max_distance double precision
)
returns table (id uuid, kind text, content text, importance smallint)
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := private.tool_call_user(p_call, 'memory.search');
begin
  if uid is null then
    raise exception 'No running memory.search call %', p_call using errcode = '42501';
  end if;
  return query
    select r.id, r.kind, r.content, r.importance
    from private.match_memories_for(uid, p_query, p_embedding::extensions.vector, p_model,
                                    least(p_count, 20), p_max_distance, null) r;
end;
$$;

create function private.tool_memory_remember(
  p_call uuid, p_kind text, p_content text, p_importance smallint,
  p_embedding text, p_model text
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.tool_call_user(p_call, 'memory.remember');
  ws uuid;
  mem uuid;
begin
  if uid is null then
    raise exception 'No running memory.remember call %', p_call using errcode = '42501';
  end if;
  select mi.workspace_id into ws
  from public.tool_calls c join public.missions mi on mi.id = c.mission_id where c.id = p_call;
  insert into public.memories
    (workspace_id, user_id, kind, content, importance, source, embedding, embedding_model)
  values (ws, uid, p_kind, p_content, p_importance, 'agent', p_embedding::extensions.vector,
          case when p_embedding is null then null else p_model end)
  returning id into mem;
  return mem;
end;
$$;

create function private.tool_memory_forget(p_call uuid, p_memory uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.tool_call_user(p_call, 'memory.forget');
begin
  if uid is null then
    raise exception 'No running memory.forget call %', p_call using errcode = '42501';
  end if;
  update public.memories set status = 'superseded'
  where id = p_memory and user_id = uid and status = 'active';
  return found;
end;
$$;

-- Only the worker runs tools.
revoke execute on function private.tool_memory_search, private.tool_memory_remember,
  private.tool_memory_forget from public;
grant usage on schema private to leana_worker;
grant execute on function private.tool_memory_search, private.tool_memory_remember,
  private.tool_memory_forget to leana_worker;

-- ---------------------------------------------------------------- RLS + grants

alter table public.tools enable row level security;
alter table public.agents enable row level security;
alter table public.tool_calls enable row level security;
revoke all on public.tools, public.agents, public.tool_calls from anon, authenticated, leana_worker;

grant select on public.tools to authenticated, leana_worker;
create policy "tools: readable" on public.tools for select to authenticated, leana_worker
  using (true);

grant select, insert (workspace_id, name, description, instructions, tools, auto_write, provider, model),
  update (name, description, instructions, tools, auto_write, provider, model), delete
  on public.agents to authenticated;
create policy "agents: read own" on public.agents for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "agents: create own" on public.agents for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "agents: update own" on public.agents for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "agents: delete own" on public.agents for delete to authenticated
  using (user_id = (select auth.uid()));
grant select (id, user_id, name, instructions, tools, auto_write, provider, model)
  on public.agents to leana_worker;
create policy "agents: worker reads" on public.agents for select to leana_worker using (true);

grant insert (agent_id) on public.missions to authenticated;

grant select on public.tool_calls to authenticated;
create policy "tool_calls: read own" on public.tool_calls for select to authenticated
  using (user_id = (select auth.uid()));
grant select, insert (mission_id, step_id, user_id, agent_id, tool, input, status, output, error, finished_at),
  update (status, output, error, finished_at)
  on public.tool_calls to leana_worker;
create policy "tool_calls: worker" on public.tool_calls for all to leana_worker
  using (true) with check (true);

grant insert (tool_call_id) on public.approvals to leana_worker;
