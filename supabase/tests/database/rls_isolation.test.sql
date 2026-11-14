-- Proof for Phase 2: tenant isolation between two users through RLS and grants.
begin;
select plan(29);

-- Two accounts, created the way Supabase Auth does (insert into auth.users).
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@test.local', '{"display_name":"Alice"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@test.local', '{}');

-- Bob's workspace id, captured as postgres for the cross-tenant checks below.
create temp table bob_ws on commit drop as
  select workspace_id as id from public.memberships
  where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
grant select on bob_ws to authenticated;

-- ---- signup trigger
select is((select display_name from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'Alice', 'signup creates a profile with the display name');
select is((select count(*)::int from public.memberships
           where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and role = 'owner'),
  1, 'signup creates a personal workspace owned by the user');
select isnt((select default_workspace_id from public.preferences
             where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  null, 'signup sets the default workspace');

-- ---- anon has no access at all
set local role anon;
select throws_ok('select * from public.profiles', '42501', null, 'anon cannot read profiles');
select throws_ok('select * from public.workspaces', '42501', null, 'anon cannot read workspaces');
reset role;

-- ---- act as Alice
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

select is((select count(*)::int from public.profiles), 1, 'Alice sees only her profile');
select is((select count(*)::int from public.workspaces), 1, 'Alice sees only her workspace');
select is((select count(*)::int from public.memberships), 1, 'Alice sees only her memberships');
select is((select count(*)::int from public.preferences), 1, 'Alice sees only her preferences');

-- Cross-tenant writes silently match 0 rows under RLS; their effect is checked as postgres below.
select lives_ok($$ update public.profiles set display_name = 'pwned'
                   where id = 'bbbbbbbb-0000-0000-0000-000000000002' $$,
  'attempt: Alice updates Bob''s profile');

select lives_ok($$ update public.profiles set display_name = 'Alice B.'
                   where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'Alice can update her own profile');

select throws_ok($$ update public.profiles set id = 'bbbbbbbb-0000-0000-0000-000000000002' $$,
  '42501', null, 'Alice cannot change her profile id (column not granted)');

-- Direct PostgREST writes bypass the API, so the database validates input too.
select throws_ok($$ update public.profiles set timezone = 'Mars/Olympus' $$,
  '22023', null, 'an unknown time zone is rejected by the database');
select throws_ok($$ update public.preferences set settings = jsonb_build_object('x', repeat('a', 20000)) $$,
  '23514', null, 'oversized preference settings are rejected');

select throws_ok(
  $$ update public.preferences set default_workspace_id = (select id from bob_ws) $$,
  '42501', null, 'Alice cannot point her default workspace at Bob''s workspace');

select lives_ok($$ delete from public.workspaces where id = (select id from bob_ws) $$,
  'attempt: Alice deletes Bob''s workspace');

select lives_ok($$ insert into public.workspaces (name) values ('Projet Alice') returning id $$,
  'Alice can create a workspace and read it back');
select is((select m.role::text from public.memberships m
           join public.workspaces w on w.id = m.workspace_id
           where w.name = 'Projet Alice'),
  'owner', 'the creator becomes owner of the new workspace');

select throws_ok(
  $$ insert into public.workspaces (name, created_by)
     values ('spoof', 'bbbbbbbb-0000-0000-0000-000000000002') $$,
  '42501', null, 'Alice cannot create a workspace on behalf of Bob');

select lives_ok($$ delete from public.memberships
                   where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  'attempt: Alice leaves her own workspaces as owner');

select lives_ok($$ insert into public.consents (kind, granted, policy_version)
                   values ('terms', true, '2026-11') $$,
  'Alice can record a consent');
select throws_ok($$ update public.consents set granted = false $$,
  '42501', null, 'consents are append-only');

-- ---- act as Bob
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from public.consents), 0, 'Bob cannot see Alice''s consents');
select is((select count(*)::int from public.workspaces), 1, 'Bob still sees only his workspace');

-- ---- effects of the forbidden attempts, seen as postgres
reset role;
select is((select display_name from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  null, 'Bob''s profile was not modified by Alice');
select is((select count(*)::int from public.workspaces where id = (select id from bob_ws)),
  1, 'Bob''s workspace was not deleted by Alice');
select is((select count(*)::int from public.memberships
           where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' and role = 'owner'),
  2, 'an owner cannot leave (and orphan) their workspaces');

-- ---- GDPR deletion
delete from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select count(*)::int from public.workspaces w
           where not exists (select 1 from public.memberships m where m.workspace_id = w.id)),
  0, 'deleting Alice leaves no orphan workspace');
select is((select array_agg(id)::text from public.profiles
           where id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002')),
  '{bbbbbbbb-0000-0000-0000-000000000002}', 'Alice''s profile is gone, Bob''s is untouched');

select * from finish();
rollback;
