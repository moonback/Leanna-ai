-- Phase 6 proof: tool permissions are enforced by the database.
--   - agents only list existing tools, and only their owner sees or uses them;
--   - a tool runs only if the mission's agent allows it right now;
--   - write tools need an approved approval (unless auto_write), sensitive ones always;
--   - the worker reaches user data only through a running call of the matching tool,
--     scoped to that call's user.
begin;
select plan(36);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a6', 'alice-ag@test.local'),
  ('bbbbbbbb-0000-0000-0000-0000000000b6', 'bob-ag@test.local');
-- A sensitive tool exists only in this test (Phase 8 connectors will bring real ones).
insert into public.tools (name, risk, label, description)
  values ('test.sensitive', 'sensitive', 'Test', 'Outil sensible de test');

create temp table ids on commit drop as select
  (select workspace_id from public.memberships where user_id = 'aaaaaaaa-0000-0000-0000-0000000000a6') as alice_ws,
  (select workspace_id from public.memberships where user_id = 'bbbbbbbb-0000-0000-0000-0000000000b6') as bob_ws;
grant select on ids to authenticated, leana_worker;
grant usage on schema extensions to leana_worker;
grant execute on all functions in schema extensions to leana_worker;

create function pg_temp.agent(n text) returns uuid language sql as $$
  select id from public.agents where name = n $$;
create function pg_temp.step(n text) returns uuid language sql as $$
  select s.id from public.mission_steps s join public.missions m on m.id = s.mission_id
  where m.title = n $$;
create function pg_temp.mission(n text) returns uuid language sql as $$
  select id from public.missions where title = n $$;
create function pg_temp.call(t text) returns uuid language sql as $$
  select id from public.tool_calls where tool = t order by created_at desc limit 1 $$;
grant execute on all functions in schema pg_temp to authenticated, leana_worker;

-- Bob's data (fixtures).
insert into public.agents (workspace_id, user_id, name, tools)
  select bob_ws, 'bbbbbbbb-0000-0000-0000-0000000000b6'::uuid, 'Agent de Bob', '{memory.search}' from ids;
insert into public.memories (workspace_id, user_id, content)
  select bob_ws, 'bbbbbbbb-0000-0000-0000-0000000000b6'::uuid, 'Bob aime les pizzas' from ids;
-- Alice cannot see Bob's agent: its id is captured here, as if guessed or leaked.
create temp table bob on commit drop as select id as agent from public.agents where name = 'Agent de Bob';
grant select on bob to authenticated;

-- ---- Alice builds agents
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a6","role":"authenticated"}', true);

select lives_ok($$
  insert into public.agents (workspace_id, name, tools, auto_write) select alice_ws, n, t, w from ids,
  (values ('Lecteur', '{memory.search,clock.now,memory.search}'::text[], false),
          ('Scribe', '{memory.remember}'::text[], false),
          ('Autonome', '{memory.remember,test.sensitive}'::text[], true)) v(n, t, w)
$$, 'Alice creates agents');
select is((select tools from public.agents where name = 'Lecteur'), '{clock.now,memory.search}'::text[],
  'tool lists are deduplicated and sorted');
select throws_ok($$ insert into public.agents (workspace_id, name, tools) select alice_ws, 'X', '{shell.exec}' from ids $$,
  '23514', null, 'an agent cannot list a tool that does not exist');
select throws_ok($$ update public.agents set tools = '{sql.raw}' where name = 'Lecteur' $$,
  '23514', null, 'nor gain one later');
select is((select count(*)::int from public.agents), 3, 'Alice sees only her agents');
select is_empty($$ update public.agents set tools = '{memory.remember}' where name = 'Agent de Bob' returning id $$,
  'Alice cannot change Bob''s agent');
select throws_ok($$ insert into public.missions (workspace_id, goal, title, agent_id)
                    select alice_ws, 'x', 'Vol', bob.agent from ids, bob $$,
  '23514', null, 'a mission cannot borrow another user''s agent');
select ok((select count(*) > 0 from public.tools), 'the tool catalog is readable');
select throws_ok($$ insert into public.tools (name, risk, label, description) values ('x.y', 'read', 'x', 'x') $$,
  '42501', null, 'nobody adds tools at runtime');
insert into public.memories (workspace_id, content) select alice_ws, 'Alice adore les pizzas' from ids;

-- Missions and running steps (as postgres: the worker's earlier work).
reset role;
insert into public.missions (workspace_id, user_id, goal, title, agent_id, status)
  select alice_ws, 'aaaaaaaa-0000-0000-0000-0000000000a6'::uuid, 'But', n, pg_temp.agent(n), 'planning'
  from ids, unnest(array['Lecteur', 'Scribe', 'Autonome']) n;
update public.missions set status = 'awaiting_approval' where title in ('Lecteur', 'Scribe', 'Autonome');
update public.missions set status = 'running' where title in ('Lecteur', 'Scribe', 'Autonome');
insert into public.mission_steps (mission_id, user_id, position, title, instruction, status, attempt)
  select id, user_id, 1, 'Étape', 'Faire', 'running', 1 from public.missions
  where title in ('Lecteur', 'Scribe', 'Autonome');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                            'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Lecteur'), 'memory.search', 'running') $$,
  '42501', null, 'users cannot record tool calls');
select throws_ok($$ select * from private.tool_memory_search(gen_random_uuid(), 'pizza', null, null, 5, 0.5) $$,
  '42501', null, 'users cannot call tool functions');

-- ---- the worker uses tools
reset role;
set local role leana_worker;
select lives_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, input, status)
                   values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                           'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Lecteur'),
                           'memory.search', '{"query":"pizza"}', 'running') $$,
  'an allowed read tool runs without approval');
select is((select array_agg(content) from private.tool_memory_search(pg_temp.call('memory.search'), 'pizza', null, null, 5, 0.5)),
  array['Alice adore les pizzas'], 'memory.search sees only the call''s user');
select throws_ok($$ select private.tool_memory_remember(pg_temp.call('memory.search'), 'fact', 'x', 3::smallint, null, null) $$,
  '42501', null, 'a call grants access to its own tool only');
update public.tool_calls set status = 'succeeded', finished_at = now() where id = pg_temp.call('memory.search');
select throws_ok($$ select * from private.tool_memory_search(pg_temp.call('memory.search'), 'pizza', null, null, 5, 0.5) $$,
  '42501', null, 'a finished call grants nothing');
select throws_ok($$ update public.tool_calls set status = 'running' where id = pg_temp.call('memory.search') $$,
  '23514', null, 'a finished call cannot be reopened');
select throws_ok($$ select count(*) from public.memories $$, '42501', null,
  'the worker still cannot read memories directly');

select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                            'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Lecteur'), 'memory.remember', 'running') $$,
  '42501', null, 'a tool outside the agent''s list cannot run');
select lives_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status, error)
                   values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                           'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Lecteur'), 'memory.remember', 'denied', 'not_allowed') $$,
  'the refusal is recorded');
select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                            'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Scribe'), 'memory.remember', 'running') $$,
  '23514', null, 'a call cannot claim another agent''s rights');
select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                            'bbbbbbbb-0000-0000-0000-0000000000b6', pg_temp.agent('Lecteur'), 'clock.now', 'running') $$,
  '23514', null, 'a call belongs to the mission owner');

-- write tool: approval required
select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Scribe'), pg_temp.step('Scribe'),
                            'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Scribe'), 'memory.remember', 'running') $$,
  '42501', null, 'a write tool cannot run without approval');
select lives_ok($$
  insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, input, status)
  values (pg_temp.mission('Scribe'), pg_temp.step('Scribe'), 'aaaaaaaa-0000-0000-0000-0000000000a6',
          pg_temp.agent('Scribe'), 'memory.remember', '{"content":"Parle italien"}', 'pending_approval');
  insert into public.approvals (mission_id, step_id, tool_call_id, user_id, kind, summary)
  values (pg_temp.mission('Scribe'), pg_temp.step('Scribe'), pg_temp.call('memory.remember'),
          'aaaaaaaa-0000-0000-0000-0000000000a6', 'tool', 'Retenir : Parle italien');
  update public.missions set status = 'awaiting_approval' where id = pg_temp.mission('Scribe');
$$, 'the worker asks for approval');
select throws_ok($$ update public.tool_calls set status = 'running' where id = pg_temp.call('memory.remember') $$,
  '42501', null, 'still blocked while the approval is pending');

reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
select lives_ok($$ update public.approvals set status = 'approved' where kind = 'tool' $$,
  'Alice approves the write');

reset role;
set local role leana_worker;
update public.missions set status = 'running' where id = pg_temp.mission('Scribe');
select lives_ok($$ update public.tool_calls set status = 'running' where id = pg_temp.call('memory.remember') $$,
  'approved: the write tool runs');
select isnt(private.tool_memory_remember(pg_temp.call('memory.remember'), 'fact', 'Parle italien', 3::smallint, null, null),
  null, 'memory.remember writes for the call''s user');
update public.tool_calls set status = 'succeeded', finished_at = now() where id = pg_temp.call('memory.remember');

-- auto_write and sensitive tools
select lives_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                   values (pg_temp.mission('Autonome'), pg_temp.step('Autonome'),
                           'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Autonome'), 'memory.remember', 'running') $$,
  'an auto_write agent writes without asking');
select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Autonome'), pg_temp.step('Autonome'),
                            'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Autonome'), 'test.sensitive', 'running') $$,
  '42501', null, 'a sensitive tool always needs approval, even with auto_write');

-- revocation is immediate
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
update public.agents set tools = '{clock.now}' where name = 'Lecteur';
reset role;
set local role leana_worker;
select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                            'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Lecteur'), 'memory.search', 'running') $$,
  '42501', null, 'a revoked tool cannot run any more');

-- no tool calls outside a running step
update public.mission_steps set status = 'done' where id = pg_temp.step('Lecteur');
select throws_ok($$ insert into public.tool_calls (mission_id, step_id, user_id, agent_id, tool, status)
                    values (pg_temp.mission('Lecteur'), pg_temp.step('Lecteur'),
                            'aaaaaaaa-0000-0000-0000-0000000000a6', pg_temp.agent('Lecteur'), 'clock.now', 'running') $$,
  '23514', null, 'tool calls only happen inside a running step');

-- ---- Alice audits
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
select is((select source from public.memories where content = 'Parle italien'), 'agent',
  'memories written by an agent are labelled');
select is((select count(*)::int from public.tool_calls), 4, 'Alice sees the calls made for her');
select ok((select bool_or(kind = 'tool.denied') and bool_or(kind = 'tool.used') from public.activity),
  'denied and write calls are in the activity log');
select lives_ok($$ delete from public.agents where name = 'Scribe' $$, 'Alice deletes an agent');
select is((select agent_id from public.missions where title = 'Scribe'), null,
  'its missions lose their agent (and with it every tool)');

select * from finish();
rollback;
