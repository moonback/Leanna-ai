-- Phase 7: projects, tasks, documents and calendar events.
--
-- Unlike conversations, memories and missions (private to their author), these belong to
-- a workspace: every member reads and edits them. Today a workspace has one member (no
-- invitations yet); the rules below are already the shared ones.
-- Agents reach them only through `private.tool_*` functions bound to a running tool call,
-- inside the mission's workspace (see the agents migration for the permission gate).

-- ---------------------------------------------------------------- tables

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (char_length(description) <= 2000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_workspace_idx on public.projects (workspace_id, status, updated_at desc);
create index projects_created_by_idx on public.projects (created_by);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  notes text check (char_length(notes) <= 4000),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'done') = (completed_at is not null))
);
create index tasks_workspace_open_idx on public.tasks (workspace_id, status, due_at);
create index tasks_project_idx on public.tasks (project_id);
create index tasks_created_by_idx on public.tasks (created_by);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content text not null default '' check (char_length(content) <= 100000),
  fts tsvector generated always as (
    setweight(to_tsvector('private.leana_search', title), 'A')
    || setweight(to_tsvector('private.leana_search', content), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_workspace_idx on public.documents (workspace_id, updated_at desc);
create index documents_project_idx on public.documents (project_id);
create index documents_created_by_idx on public.documents (created_by);
create index documents_fts_idx on public.documents using gin (fts);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (char_length(description) <= 4000),
  location text check (char_length(location) <= 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at >= starts_at),
  check (ends_at - starts_at <= interval '366 days')
);
create index events_workspace_time_idx on public.events (workspace_id, starts_at);
create index events_project_idx on public.events (project_id);
create index events_created_by_idx on public.events (created_by);

-- ---------------------------------------------------------------- triggers

create trigger projects_updated_at before update on public.projects
  for each row execute function private.set_updated_at();
create trigger tasks_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();
create trigger documents_updated_at before update on public.documents
  for each row execute function private.set_updated_at();
create trigger events_updated_at before update on public.events
  for each row execute function private.set_updated_at();

-- A project link stays inside the workspace (foreign keys bypass RLS; this does not).
-- Moving an item to another workspace is not allowed: workspace_id is not updatable.
create function private.check_project_link() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.project_id is not null
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
     and not exists (
       select 1 from public.projects p
       where p.id = new.project_id and p.workspace_id = new.workspace_id
     ) then
    raise exception 'project_id must be a project of the same workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tasks_project_link before insert or update of project_id on public.tasks
  for each row execute function private.check_project_link();
create trigger documents_project_link before insert or update of project_id on public.documents
  for each row execute function private.check_project_link();
create trigger events_project_link before insert or update of project_id on public.events
  for each row execute function private.check_project_link();

-- completed_at follows the status: set when done, cleared when reopened.
create function private.task_completion() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;
create trigger tasks_completion before insert or update of status on public.tasks
  for each row execute function private.task_completion();

-- ---------------------------------------------------------------- RLS + grants

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.documents enable row level security;
alter table public.events enable row level security;
revoke all on public.projects, public.tasks, public.documents, public.events
  from anon, authenticated, leana_worker;

grant select, insert (workspace_id, name, description, status),
  update (name, description, status), delete on public.projects to authenticated;
grant select, insert (workspace_id, project_id, title, notes, status, priority, due_at),
  update (project_id, title, notes, status, priority, due_at), delete on public.tasks to authenticated;
grant select (id, workspace_id, project_id, created_by, title, content, fts, created_at, updated_at),
  insert (workspace_id, project_id, title, content),
  update (project_id, title, content), delete on public.documents to authenticated;
grant select, insert (workspace_id, project_id, title, description, location, starts_at, ends_at, all_day),
  update (project_id, title, description, location, starts_at, ends_at, all_day), delete
  on public.events to authenticated;

-- Workspace members share these. Creation records the creator (never someone else).
create policy "projects: members read" on public.projects for select to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));
create policy "projects: members create" on public.projects for insert to authenticated
  with check (private.has_workspace_role(workspace_id, 'member') and created_by = (select auth.uid()));
create policy "projects: members edit" on public.projects for update to authenticated
  using (private.has_workspace_role(workspace_id, 'member'))
  with check (private.has_workspace_role(workspace_id, 'member'));
create policy "projects: members delete" on public.projects for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));

create policy "tasks: members read" on public.tasks for select to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));
create policy "tasks: members create" on public.tasks for insert to authenticated
  with check (private.has_workspace_role(workspace_id, 'member') and created_by = (select auth.uid()));
create policy "tasks: members edit" on public.tasks for update to authenticated
  using (private.has_workspace_role(workspace_id, 'member'))
  with check (private.has_workspace_role(workspace_id, 'member'));
create policy "tasks: members delete" on public.tasks for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));

create policy "documents: members read" on public.documents for select to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));
create policy "documents: members create" on public.documents for insert to authenticated
  with check (private.has_workspace_role(workspace_id, 'member') and created_by = (select auth.uid()));
create policy "documents: members edit" on public.documents for update to authenticated
  using (private.has_workspace_role(workspace_id, 'member'))
  with check (private.has_workspace_role(workspace_id, 'member'));
create policy "documents: members delete" on public.documents for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));

create policy "events: members read" on public.events for select to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));
create policy "events: members create" on public.events for insert to authenticated
  with check (private.has_workspace_role(workspace_id, 'member') and created_by = (select auth.uid()));
create policy "events: members edit" on public.events for update to authenticated
  using (private.has_workspace_role(workspace_id, 'member'))
  with check (private.has_workspace_role(workspace_id, 'member'));
create policy "events: members delete" on public.events for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));

-- Document search for the API (security invoker: RLS scopes the rows).
create function public.search_documents(q text, max_rows integer default 20)
returns table (id uuid, title text, snippet text, project_id uuid, updated_at timestamptz, rank real)
language sql stable security invoker set search_path = '' as $$
  select d.id, d.title,
         pg_catalog.ts_headline('private.leana_search', d.content, private.memory_query(q),
           'MaxWords=30, MinWords=10, StartSel=«, StopSel=», MaxFragments=1'),
         d.project_id, d.updated_at, pg_catalog.ts_rank_cd(d.fts, private.memory_query(q))
  from public.documents d
  where d.fts @@ private.memory_query(q)
  order by 6 desc, d.updated_at desc
  limit least(greatest(coalesce(max_rows, 20), 1), 50);
$$;
revoke execute on function public.search_documents from public, anon;
grant execute on function public.search_documents to authenticated;

-- ---------------------------------------------------------------- agent tools

insert into public.tools (name, risk, label, description) values
  ('tasks.list', 'read', 'Lister les tâches',
   'Tâches de l''espace de travail (ouvertes par défaut), triées par échéance.'),
  ('tasks.create', 'write', 'Créer une tâche',
   'Ajoute une tâche (titre, notes, priorité, échéance).'),
  ('tasks.complete', 'write', 'Terminer une tâche', 'Marque une tâche comme faite.'),
  ('calendar.list', 'read', 'Consulter l''agenda', 'Événements entre deux dates.'),
  ('calendar.create', 'write', 'Créer un événement',
   'Ajoute un événement à l''agenda de l''espace de travail.'),
  ('documents.search', 'read', 'Chercher dans les documents',
   'Recherche plein texte dans les documents de l''espace de travail.'),
  ('documents.create', 'write', 'Créer un document',
   'Enregistre un document (titre et contenu texte).');

-- The running call's user and its mission's workspace, if the user is still a member.
create function private.tool_scope(p_call uuid, p_tool text, out uid uuid, out ws uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  select c.user_id, mi.workspace_id into uid, ws
  from public.tool_calls c join public.missions mi on mi.id = c.mission_id
  where c.id = p_call and c.tool = p_tool and c.status = 'running'
    and exists (select 1 from public.memberships m
                where m.workspace_id = mi.workspace_id and m.user_id = c.user_id);
  if uid is null then
    raise exception 'No running % call %', p_tool, p_call using errcode = '42501';
  end if;
end;
$$;
revoke execute on function private.tool_scope from public;

create function private.tool_tasks_list(p_call uuid, p_status text, p_limit integer)
returns table (id uuid, title text, status text, priority text, due_at timestamptz, project text)
language plpgsql stable security definer set search_path = '' as $$
declare s record := private.tool_scope(p_call, 'tasks.list');
begin
  return query
    select t.id, t.title, t.status, t.priority, t.due_at, p.name
    from public.tasks t left join public.projects p on p.id = t.project_id
    where t.workspace_id = s.ws
      and (case when p_status = 'all' then true
                when p_status = 'open' then t.status <> 'done'
                else t.status = p_status end)
    order by t.due_at nulls last, t.created_at
    limit least(greatest(p_limit, 1), 50);
end;
$$;

create function private.tool_tasks_create(
  p_call uuid, p_title text, p_notes text, p_priority text, p_due_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s record := private.tool_scope(p_call, 'tasks.create');
  task uuid;
begin
  insert into public.tasks (workspace_id, created_by, title, notes, priority, due_at)
  values (s.ws, s.uid, p_title, p_notes, p_priority, p_due_at)
  returning id into task;
  return task;
end;
$$;

create function private.tool_tasks_complete(p_call uuid, p_task uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare s record := private.tool_scope(p_call, 'tasks.complete');
begin
  update public.tasks set status = 'done'
  where id = p_task and workspace_id = s.ws and status <> 'done';
  return found;
end;
$$;

create function private.tool_calendar_list(p_call uuid, p_from timestamptz, p_to timestamptz)
returns table (id uuid, title text, starts_at timestamptz, ends_at timestamptz, all_day boolean,
               location text)
language plpgsql stable security definer set search_path = '' as $$
declare s record := private.tool_scope(p_call, 'calendar.list');
begin
  return query
    select e.id, e.title, e.starts_at, e.ends_at, e.all_day, e.location
    from public.events e
    where e.workspace_id = s.ws and e.ends_at >= p_from and e.starts_at < p_to
    order by e.starts_at
    limit 100;
end;
$$;

create function private.tool_calendar_create(
  p_call uuid, p_title text, p_starts timestamptz, p_ends timestamptz, p_all_day boolean,
  p_location text, p_description text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s record := private.tool_scope(p_call, 'calendar.create');
  ev uuid;
begin
  insert into public.events
    (workspace_id, created_by, title, starts_at, ends_at, all_day, location, description)
  values (s.ws, s.uid, p_title, p_starts, p_ends, p_all_day, p_location, p_description)
  returning id into ev;
  return ev;
end;
$$;

create function private.tool_documents_search(p_call uuid, p_query text, p_limit integer)
returns table (id uuid, title text, snippet text)
language plpgsql stable security definer set search_path = '' as $$
declare s record := private.tool_scope(p_call, 'documents.search');
begin
  return query
    select d.id, d.title,
           pg_catalog.ts_headline('private.leana_search', d.content, private.memory_query(p_query),
             'MaxWords=40, MinWords=15, MaxFragments=2')
    from public.documents d
    where d.workspace_id = s.ws and d.fts @@ private.memory_query(p_query)
    order by pg_catalog.ts_rank_cd(d.fts, private.memory_query(p_query)) desc
    limit least(greatest(p_limit, 1), 10);
end;
$$;

create function private.tool_documents_create(p_call uuid, p_title text, p_content text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s record := private.tool_scope(p_call, 'documents.create');
  doc uuid;
begin
  insert into public.documents (workspace_id, created_by, title, content)
  values (s.ws, s.uid, p_title, p_content)
  returning id into doc;
  return doc;
end;
$$;

revoke execute on function private.tool_tasks_list, private.tool_tasks_create,
  private.tool_tasks_complete, private.tool_calendar_list, private.tool_calendar_create,
  private.tool_documents_search, private.tool_documents_create from public;
grant execute on function private.tool_tasks_list, private.tool_tasks_create,
  private.tool_tasks_complete, private.tool_calendar_list, private.tool_calendar_create,
  private.tool_documents_search, private.tool_documents_create to leana_worker;
