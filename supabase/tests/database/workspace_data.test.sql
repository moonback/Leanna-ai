-- Phase 7 proof: projects, tasks, documents and events are shared inside a workspace,
-- invisible outside it, constrained by the database, and reachable by agents only
-- through a running tool call, inside the mission's workspace.
begin;
select plan(32);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a7', 'alice-wd@test.local'),
  ('bbbbbbbb-0000-0000-0000-0000000000b7', 'bob-wd@test.local'),
  ('cccccccc-0000-0000-0000-0000000000c7', 'carol-wd@test.local');

create temp table ids on commit drop as select
  (select workspace_id from public.memberships where user_id = 'aaaaaaaa-0000-0000-0000-0000000000a7') as alice_ws,
  (select workspace_id from public.memberships where user_id = 'bbbbbbbb-0000-0000-0000-0000000000b7') as bob_ws;
grant select on ids to authenticated, leana_worker;
-- Carol is a member of Alice's workspace (invitations come later: fixture).
insert into public.memberships (workspace_id, user_id, role)
  select alice_ws, 'cccccccc-0000-0000-0000-0000000000c7', 'member' from ids;
-- Bob's data.
insert into public.projects (workspace_id, created_by, name)
  select bob_ws, 'bbbbbbbb-0000-0000-0000-0000000000b7', 'Projet de Bob' from ids;
insert into public.tasks (workspace_id, created_by, title)
  select bob_ws, 'bbbbbbbb-0000-0000-0000-0000000000b7', 'Tâche de Bob' from ids;
create temp table bob on commit drop as
  select (select id from public.projects where name = 'Projet de Bob'
          and workspace_id = (select bob_ws from ids)) as project,
         (select id from public.tasks where title = 'Tâche de Bob'
          and workspace_id = (select bob_ws from ids)) as task;
grant select on bob to authenticated;

create function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user to authenticated;

-- ---- Alice organises her workspace
set local role authenticated;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a7');

select lives_ok($$
  insert into public.projects (workspace_id, name) select alice_ws, 'Déménagement' from ids;
  insert into public.tasks (workspace_id, project_id, title, priority, due_at)
    select alice_ws, (select id from public.projects where name = 'Déménagement'),
           'Résilier le bail', 'urgent', now() + interval '2 days' from ids;
  insert into public.documents (workspace_id, title, content)
    select alice_ws, 'Inventaire', 'Cartons de livres, vaisselle fragile et plantes vertes' from ids;
  insert into public.events (workspace_id, title, starts_at, ends_at)
    select alice_ws, 'Camion de location', now() + interval '3 days', now() + interval '3 days 4 hours' from ids;
$$, 'Alice creates a project, a task, a document and an event');
select is((select created_by from public.tasks where title = 'Résilier le bail'),
  'aaaaaaaa-0000-0000-0000-0000000000a7'::uuid, 'the creator is recorded');
select throws_ok($$ insert into public.tasks (workspace_id, title, created_by)
                    select alice_ws, 'x', 'cccccccc-0000-0000-0000-0000000000c7' from ids $$,
  '42501', null, 'nobody creates in someone else''s name');

-- isolation
select is((select count(*)::int from public.tasks), 1, 'Alice does not see Bob''s tasks');
select throws_ok($$ insert into public.tasks (workspace_id, title) select bob_ws, 'x' from ids $$,
  '42501', null, 'Alice cannot write into Bob''s workspace');
select throws_ok($$ insert into public.tasks (workspace_id, project_id, title) select alice_ws, bob.project, 'x' from ids, bob $$,
  '23514', null, 'a task cannot point to a project of another workspace');
select is_empty($$ update public.tasks set title = 'piraté' where id = (select task from bob) returning id $$,
  'Alice cannot edit Bob''s task');
select is_empty($$ delete from public.projects where id = (select project from bob) returning id $$,
  'Alice cannot delete Bob''s project');
select throws_ok($$ update public.tasks set workspace_id = (select bob_ws from ids) $$,
  '42501', null, 'items cannot move to another workspace');

-- constraints
select throws_ok($$ insert into public.events (workspace_id, title, starts_at, ends_at)
                    select alice_ws, 'x', now(), now() - interval '1 hour' from ids $$,
  '23514', null, 'an event cannot end before it starts');
select throws_ok($$ insert into public.tasks (workspace_id, title, priority) select alice_ws, 'x', 'critique' from ids $$,
  '23514', null, 'priorities are a fixed list');
select throws_ok($$ insert into public.tasks (workspace_id, title) select alice_ws, '  ' from ids $$,
  '23514', null, 'blank titles are rejected');
select throws_ok($$ insert into public.documents (workspace_id, title, content) select alice_ws, 'x', repeat('x', 100001) from ids $$,
  '23514', null, 'documents are capped at 100 000 characters');

-- completion
update public.tasks set status = 'done' where title = 'Résilier le bail';
select isnt((select completed_at from public.tasks where title = 'Résilier le bail'), null,
  'completing a task timestamps it');
update public.tasks set status = 'todo' where title = 'Résilier le bail';
select is((select completed_at from public.tasks where title = 'Résilier le bail'), null,
  'reopening clears the timestamp');

-- search
select is((select title from public.search_documents('vaisselle')), 'Inventaire',
  'documents are searchable');
select is((select count(*)::int from public.search_documents('Bob')), 0,
  'search stays inside the caller''s workspaces');

-- ---- Carol, member of the same workspace, shares it
select pg_temp.as_user('cccccccc-0000-0000-0000-0000000000c7');
select is((select count(*)::int from public.tasks), 1, 'a co-member sees the workspace tasks');
select lives_ok($$ update public.tasks set status = 'in_progress' where title = 'Résilier le bail' $$,
  'a co-member edits them');

-- ---- deleting a project keeps its tasks
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a7');
insert into public.projects (workspace_id, name) select alice_ws, 'Éphémère' from ids;
update public.tasks set project_id = (select id from public.projects where name = 'Éphémère')
  where title = 'Résilier le bail';
delete from public.projects where name = 'Éphémère';
select is((select project_id from public.tasks where title = 'Résilier le bail'), null,
  'deleting a project detaches its tasks');

-- ---- agent tools: a running mission of Alice with an agent allowed every tool
reset role;
insert into public.agents (workspace_id, user_id, name, tools, auto_write)
  select alice_ws, 'aaaaaaaa-0000-0000-0000-0000000000a7', 'Organisateur',
         '{tasks.list,tasks.create,tasks.complete,calendar.list,calendar.create,documents.search,documents.create}', true
  from ids;
insert into public.missions (workspace_id, user_id, goal, title, agent_id)
  select alice_ws, 'aaaaaaaa-0000-0000-0000-0000000000a7', 'But', 'Organiser',
         (select id from public.agents where name = 'Organisateur'
          and user_id = 'aaaaaaaa-0000-0000-0000-0000000000a7') from ids;
create temp table m on commit drop as
  select id, agent_id, user_id from public.missions
  where title = 'Organiser' and user_id = 'aaaaaaaa-0000-0000-0000-0000000000a7';
grant select on m to leana_worker;
update public.missions set status = 'awaiting_approval' where id = (select id from m);
update public.missions set status = 'running' where id = (select id from m);
insert into public.mission_steps (mission_id, user_id, position, title, instruction, status, attempt)
  select id, user_id, 1, 'Étape', 'Faire', 'running', 1 from m;

create function pg_temp.open_call(t text) returns uuid language plpgsql as $$
declare c uuid;
begin
  insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
  select m.id, s.id, m.user_id, m.agent_id, t, 'running'
  from m join public.mission_steps s on s.mission_id = m.id
  returning id into c;
  return c;
end;
$$;
grant execute on function pg_temp.open_call to leana_worker;
-- The latest call of a tool (calls are opened in their own statement, as the worker does:
-- tool functions read a snapshot taken before the statement that would create the call).
create function pg_temp.c(t text) returns uuid language sql as $$
  select id from public.tool_calls where tool = t and mission_id = (select id from m)
  order by created_at desc limit 1 $$;
grant execute on function pg_temp.c to leana_worker;
grant usage on schema extensions to leana_worker;
grant execute on all functions in schema extensions to leana_worker;

set local role leana_worker;
select pg_temp.open_call(t) from unnest(array['tasks.list', 'tasks.create', 'tasks.complete',
  'calendar.list', 'calendar.create', 'documents.search', 'documents.create']) t;
select is((select array_agg(title) from private.tool_tasks_list(pg_temp.c('tasks.list'), 'open', 10)),
  array['Résilier le bail'], 'tasks.list sees the mission workspace only');
select throws_ok($$ select * from public.tasks $$, '42501', null,
  'the worker cannot read tasks directly');
select isnt(private.tool_tasks_create(pg_temp.c('tasks.create'), 'Commander des cartons', null, 'high', null),
  null, 'tasks.create adds a task');
select ok(private.tool_tasks_complete(pg_temp.c('tasks.complete'),
            (select id from private.tool_tasks_list(pg_temp.c('tasks.list'), 'open', 10)
             where title = 'Commander des cartons')),
  'tasks.complete finishes it');
select is((select count(*)::int from private.tool_calendar_list(pg_temp.c('calendar.list'), now(), now() + interval '7 days')),
  1, 'calendar.list reads the agenda');
select isnt(private.tool_calendar_create(pg_temp.c('calendar.create'), 'Remise des clés',
            now() + interval '5 days', now() + interval '5 days 1 hour', false, 'Lyon', null),
  null, 'calendar.create adds an event');
select is((select title from private.tool_documents_search(pg_temp.c('documents.search'), 'plantes', 5)),
  'Inventaire', 'documents.search finds a document');
select isnt(private.tool_documents_create(pg_temp.c('documents.create'), 'Checklist', 'Relever les compteurs'),
  null, 'documents.create saves a document');
select throws_ok($$ select private.tool_tasks_complete(pg_temp.c('tasks.list'), (select task from bob)) $$,
  '42501', null, 'a call grants access to its own tool only');
select ok(not private.tool_tasks_complete(pg_temp.c('tasks.complete'),
            'ffffffff-0000-0000-0000-000000000000'),
  'tasks.complete never reaches another workspace');

-- ---- Alice sees what the agent did, attributed to her
reset role;
set local role authenticated;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-0000000000a7');
select is((select created_by from public.tasks where title = 'Commander des cartons'),
  'aaaaaaaa-0000-0000-0000-0000000000a7'::uuid, 'agent-created items belong to the mission owner');
select is((select count(*)::int from public.events), 2, 'the agent''s event is in her agenda');

select * from finish();
rollback;
