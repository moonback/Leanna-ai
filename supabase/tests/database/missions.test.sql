-- Phase 5 proof: missions are isolated; users may only create, cancel, decide approvals
-- and read notifications; the worker role drives the state machine; activity and
-- notifications are written by triggers only.
begin;
select plan(37);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a5', 'alice-mi@test.local'),
  ('bbbbbbbb-0000-0000-0000-0000000000b5', 'bob-mi@test.local');

create temp table ids on commit drop as select
  (select workspace_id from public.memberships where user_id = 'aaaaaaaa-0000-0000-0000-0000000000a5') as alice_ws,
  (select workspace_id from public.memberships where user_id = 'bbbbbbbb-0000-0000-0000-0000000000b5') as bob_ws;
grant select on ids to authenticated, leana_worker;
-- pgTAP itself must be callable while acting as the worker (rolled back with the test).
grant usage on schema extensions to leana_worker;
grant execute on all functions in schema extensions to leana_worker;

create function pg_temp.mission(t text) returns uuid language sql as $$
  select id from public.missions where title = t
$$;
grant execute on function pg_temp.mission to authenticated, leana_worker;

-- Bob's mission (fixture).
insert into public.missions (workspace_id, user_id, goal, title)
  select bob_ws, 'bbbbbbbb-0000-0000-0000-0000000000b5'::uuid, 'Secret', 'Bob' from ids;

-- ---- Alice creates missions
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a5","role":"authenticated"}', true);

select lives_ok($$ insert into public.missions (workspace_id, goal, title)
                   select alice_ws, 'Préparer un voyage à Rome', 'Rome' from ids $$,
  'Alice creates a mission');
insert into public.missions (workspace_id, goal, title)
  select alice_ws, 'Écrire un discours', 'Discours' from ids;
select is((select status from public.missions where title = 'Rome'), 'planning',
  'a new mission starts in planning');
select is((select count(*)::int from public.missions), 2, 'Alice sees only her missions');
select throws_ok($$ insert into public.missions (workspace_id, goal, title) select bob_ws, 'x', 'x' from ids $$,
  '42501', null, 'Alice cannot create a mission in Bob''s workspace');
select throws_ok($$ insert into public.missions (workspace_id, goal, title, status)
                    select alice_ws, 'x', 'x', 'completed' from ids $$,
  '42501', null, 'Alice cannot choose the initial status');
select throws_ok($$ update public.missions set status = 'completed' where title = 'Rome' $$,
  '42501', null, 'Alice cannot complete her mission herself');
select throws_ok($$ update public.missions set result = 'forgé' where title = 'Rome' $$,
  '42501', null, 'Alice cannot write the result');
select is_empty($$ update public.missions set status = 'cancelled' where title = 'Bob' returning id $$,
  'Alice cannot cancel Bob''s mission');
select throws_ok($$ insert into public.mission_steps (mission_id, user_id, position, title, instruction)
                    select pg_temp.mission('Rome'), 'aaaaaaaa-0000-0000-0000-0000000000a5', 1, 'x', 'x' $$,
  '42501', null, 'Alice cannot add steps');
select throws_ok($$ insert into public.activity (user_id, kind, summary)
                    values ('aaaaaaaa-0000-0000-0000-0000000000a5', 'fake', 'forged') $$,
  '42501', null, 'nobody writes the activity log directly');

-- ---- the worker plans
reset role;
set local role leana_worker;
select is((select count(*)::int from public.missions m join ids on m.workspace_id in (ids.alice_ws, ids.bob_ws)), 3,
  'the worker sees every user''s missions');
select lives_ok($$
  insert into public.mission_steps (mission_id, user_id, position, title, instruction, requires_approval)
  select pg_temp.mission('Rome'), 'aaaaaaaa-0000-0000-0000-0000000000a5', p, t, t, p = 2
  from (values (1, 'Chercher des vols'), (2, 'Réserver l''hôtel')) v(p, t)
$$, 'the worker inserts the plan');
select throws_ok($$ insert into public.mission_steps (mission_id, user_id, position, title, instruction)
                    select pg_temp.mission('Rome'), 'bbbbbbbb-0000-0000-0000-0000000000b5', 3, 'x', 'x' $$,
  '23514', null, 'steps always belong to the mission owner');
select lives_ok($$
  insert into public.approvals (mission_id, user_id, kind, summary)
  values (pg_temp.mission('Rome'), 'aaaaaaaa-0000-0000-0000-0000000000a5', 'plan', 'Plan de 2 étapes');
  update public.missions set status = 'awaiting_approval' where id = pg_temp.mission('Rome');
$$, 'the worker requests approval of the plan');
select throws_ok($$ insert into public.approvals (mission_id, user_id, kind, summary)
                    values (pg_temp.mission('Rome'), 'aaaaaaaa-0000-0000-0000-0000000000a5', 'plan', 'bis') $$,
  '23505', null, 'the plan is approved only once');
select throws_ok($$ update public.missions set status = 'completed' where id = pg_temp.mission('Rome') $$,
  '23514', null, 'the state machine forbids skipping execution');
select throws_ok($$ update public.approvals set status = 'approved' where mission_id = pg_temp.mission('Rome') $$,
  '42501', null, 'the worker cannot decide in the user''s place');
select throws_ok($$ select * from public.memories $$, '42501', null,
  'the worker cannot read memories');
select throws_ok($$ select * from public.messages $$, '42501', null,
  'the worker cannot read conversations');
select throws_ok($$ select email from auth.users $$, '42501', null,
  'the worker cannot read accounts');

-- ---- Alice decides
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
select throws_ok($$ update public.approvals set summary = 'autre' $$,
  '42501', null, 'Alice cannot rewrite what she approves');
select throws_ok($$ update public.approvals set status = 'maybe' $$,
  '23514', null, 'a decision is approved or rejected');
select lives_ok($$ update public.approvals set status = 'approved' $$, 'Alice approves the plan');
select isnt((select decided_at from public.approvals), null, 'the decision is timestamped');
select throws_ok($$ update public.approvals set status = 'rejected' $$,
  '23514', null, 'a decision is final');

-- ---- the worker runs, with a fenced retry
reset role;
set local role leana_worker;
update public.missions set status = 'running' where id = pg_temp.mission('Rome');
update public.mission_steps set status = 'running', attempt = 1, lease_until = now() + interval '1 minute'
  where mission_id = pg_temp.mission('Rome') and position = 1;
-- a crash, then another worker reclaims the step with a new attempt
update public.mission_steps set attempt = 2 where mission_id = pg_temp.mission('Rome') and position = 1;
update public.mission_steps set status = 'done', output = 'Vols trouvés', finished_at = now()
  where mission_id = pg_temp.mission('Rome') and position = 1 and attempt = 2;
select is((select output from public.mission_steps where mission_id = pg_temp.mission('Rome') and position = 1), 'Vols trouvés',
  'the current attempt completes the step');
select is_empty($$ update public.mission_steps set output = 'zombie'
                   where mission_id = pg_temp.mission('Rome') and position = 1 and attempt = 1 and status = 'running' returning id $$,
  'a stale attempt can no longer write');
update public.missions set status = 'completed', result = 'Voyage prêt' where id = pg_temp.mission('Rome');
select isnt((select finished_at from public.missions where id = pg_temp.mission('Rome')), null,
  'a finished mission is timestamped');
select throws_ok($$ update public.missions set status = 'running' where id = pg_temp.mission('Rome') $$,
  '23514', null, 'a finished mission stays finished');

-- ---- Alice reads the trail
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
select is((select array_agg(kind order by created_at) from public.activity
           where mission_id = pg_temp.mission('Rome')),
  array['mission.created', 'approval.requested', 'approval.approved', 'step.retried', 'step.done',
        'mission.completed'],
  'every transition is in the activity log, including the retry');
select is((select count(*)::int from public.activity where kind = 'mission.created'), 2,
  'Alice does not see Bob''s activity');
select is((select array_agg(title order by created_at) from public.notifications),
  array['Validation demandée : Plan de 2 étapes', 'Mission terminée : Rome'],
  'notifications for what needs attention');
select is((select link from public.notifications limit 1), '/missions/' || pg_temp.mission('Rome'),
  'notifications link to the mission');
select lives_ok($$ update public.notifications set read_at = now() $$, 'Alice marks them read');
select throws_ok($$ update public.notifications set title = 'x' $$,
  '42501', null, 'notification text is read-only');
select throws_ok($$ delete from public.activity $$, '42501', null, 'the activity log is append-only');

select lives_ok($$ update public.missions set status = 'cancelled' where title = 'Discours' $$,
  'Alice cancels a mission');

select * from finish();
rollback;
