-- Phase 3 proof: conversations, messages and usage ledger are isolated and constrained.
begin;
select plan(22);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'alice-a@test.local'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'bob-a@test.local');

create temp table ids on commit drop as select
  (select workspace_id from public.memberships where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a') as alice_ws,
  (select workspace_id from public.memberships where user_id = 'bbbbbbbb-0000-0000-0000-00000000000b') as bob_ws,
  gen_random_uuid() as alice_conv,
  gen_random_uuid() as bob_conv;
grant select on ids to authenticated;

-- Bob's conversation, created as postgres (test fixture).
insert into public.conversations (id, workspace_id, user_id, title)
  select bob_conv, bob_ws, 'bbbbbbbb-0000-0000-0000-00000000000b', 'Bob' from ids;
-- Alice's conversation id is fixed so it can be referenced below.
insert into public.conversations (id, workspace_id, user_id, title)
  select alice_conv, alice_ws, 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alice' from ids;
update public.conversations set updated_at = now() - interval '1 hour';

-- ---- act as Alice
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select lives_ok($$ insert into public.conversations (workspace_id, title)
                   select alice_ws, 'Nouvelle' from ids returning id $$,
  'Alice creates a conversation in her workspace and reads it back');
select throws_ok($$ insert into public.conversations (workspace_id) select bob_ws from ids $$,
  '42501', null, 'Alice cannot create a conversation in Bob''s workspace');
select throws_ok($$ insert into public.conversations (workspace_id, user_id)
                    select alice_ws, 'bbbbbbbb-0000-0000-0000-00000000000b' from ids $$,
  '42501', null, 'Alice cannot set the conversation owner');
select throws_ok($$ insert into public.conversations (workspace_id, title)
                    select alice_ws, repeat('x', 121) from ids $$,
  '23514', null, 'titles are capped at 120 characters');

select is((select count(*)::int from public.conversations), 2, 'Alice sees only her 2 conversations');

select lives_ok($$ insert into public.messages (conversation_id, role, content)
                   select alice_conv, 'user', 'Bonjour' from ids $$,
  'Alice appends a message to her conversation');
select throws_ok($$ insert into public.messages (conversation_id, role, content)
                    select bob_conv, 'user', 'intrusion' from ids $$,
  '42501', null, 'Alice cannot write into Bob''s conversation');
select throws_ok($$ insert into public.messages (conversation_id, role, content)
                    select alice_conv, 'system', 'override' from ids $$,
  '23514', null, 'only user/assistant roles are accepted');
select throws_ok($$ insert into public.messages (conversation_id, role, content)
                    select alice_conv, 'user', repeat('x', 32001) from ids $$,
  '23514', null, 'message content is capped at 32000 characters');
select throws_ok($$ update public.messages set content = 'edited' $$,
  '42501', null, 'messages are immutable');

select lives_ok($$ insert into public.ai_usage (conversation_id, model, input_tokens, output_tokens)
                   select alice_conv, 'gemini-3.8-flash', 120, 45 from ids $$,
  'Alice records usage');
select throws_ok($$ update public.ai_usage set output_tokens = 0 $$,
  '42501', null, 'usage cannot be rewritten');
select throws_ok($$ delete from public.ai_usage $$,
  '42501', null, 'usage cannot be erased');
select throws_ok($$ insert into public.ai_usage (model, input_tokens, output_tokens)
                    values ('gemini-3.8-flash', -1, 0) $$,
  '23514', null, 'negative token counts are rejected');
select throws_ok($$ insert into public.ai_usage (conversation_id, model, input_tokens, output_tokens)
                    select bob_conv, 'gemini-3.8-flash', 1, 1 from ids $$,
  '42501', null, 'usage cannot be attached to Bob''s conversation');

select lives_ok($$ delete from public.conversations where id = (select bob_conv from ids) $$,
  'attempt: Alice deletes Bob''s conversation');

-- ---- act as Bob
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.conversations), 1, 'Bob sees only his conversation');
select is((select count(*)::int from public.messages), 0, 'Bob cannot read Alice''s messages');
select is((select count(*)::int from public.ai_usage), 0, 'Bob cannot read Alice''s usage');

-- ---- checks as postgres
reset role;
select is((select count(*)::int from public.conversations where id = (select bob_conv from ids)),
  1, 'Bob''s conversation survived Alice''s delete attempt');
select ok((select updated_at > now() - interval '1 minute' from public.conversations
           where id = (select alice_conv from ids)),
  'a new message bumps the conversation');

delete from auth.users where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
select is((select count(*)::int from public.ai_usage
           where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a'),
  0, 'deleting the account removes its conversations, messages and usage');

select * from finish();
rollback;
