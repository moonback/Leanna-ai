-- Phase 4 proof: memories are isolated, constrained, and recalled by hybrid search
-- (lexical + vector, fused), with superseded (contradicted) facts never recalled.
begin;
select plan(28);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a4', 'alice-m@test.local'),
  ('bbbbbbbb-0000-0000-0000-0000000000b4', 'bob-m@test.local');

-- 768-d test vectors: a one-hot direction per "topic", optionally blended with another.
create function pg_temp.vec(topic int, other int default null, w float default 0)
returns extensions.vector language sql immutable as $$
  select (
    '[' || string_agg(
      case when i = topic then (1 - w)::text when i = other then w::text else '0' end, ','
      order by i) || ']'
  )::extensions.vector
  from generate_series(1, 768) i;
$$;
grant execute on function pg_temp.vec to authenticated;

create temp table ids on commit drop as select
  (select workspace_id from public.memberships where user_id = 'aaaaaaaa-0000-0000-0000-0000000000a4') as alice_ws,
  (select workspace_id from public.memberships where user_id = 'bbbbbbbb-0000-0000-0000-0000000000b4') as bob_ws,
  gen_random_uuid() as alice_conv, gen_random_uuid() as bob_conv,
  gen_random_uuid() as alice_msg, gen_random_uuid() as alice_reply, gen_random_uuid() as bob_msg,
  gen_random_uuid() as bob_mem;
grant select on ids to authenticated;

-- Fixtures written as postgres.
insert into public.conversations (id, workspace_id, user_id)
  select alice_conv, alice_ws, 'aaaaaaaa-0000-0000-0000-0000000000a4'::uuid from ids
  union all select bob_conv, bob_ws, 'bbbbbbbb-0000-0000-0000-0000000000b4'::uuid from ids;
insert into public.messages (id, conversation_id, user_id, role, content)
  select alice_msg, alice_conv, 'aaaaaaaa-0000-0000-0000-0000000000a4'::uuid, 'user', 'J''habite à Paris' from ids
  union all select alice_reply, alice_conv, 'aaaaaaaa-0000-0000-0000-0000000000a4'::uuid, 'assistant', 'Noté' from ids
  union all select bob_msg, bob_conv, 'bbbbbbbb-0000-0000-0000-0000000000b4'::uuid, 'user', 'secret' from ids;
insert into public.memories (id, workspace_id, user_id, content, embedding, embedding_model)
  select bob_mem, bob_ws, 'bbbbbbbb-0000-0000-0000-0000000000b4'::uuid,
         'Bob adore les pizzas', pg_temp.vec(1), 'test-embed' from ids;

-- ---- act as Alice
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a4","role":"authenticated"}', true);

select lives_ok($$
  insert into public.memories (workspace_id, kind, content, importance, embedding, embedding_model)
  select alice_ws, 'preference', 'Préfère les pizzas napolitaines', 4, pg_temp.vec(1), 'test-embed' from ids
  union all select alice_ws, 'fact', 'Habite à Paris', 3, pg_temp.vec(2), 'test-embed' from ids
  union all select alice_ws, 'goal', 'Courir un semi-marathon en avril', 3, pg_temp.vec(3), 'test-embed' from ids
$$, 'Alice stores memories with embeddings');
select lives_ok($$
  insert into public.memories (workspace_id, content, source, source_message_id)
  select alice_ws, 'Travaille chez Acme', 'conversation', alice_msg from ids
$$, 'a memory may cite one of her own user messages, without an embedding yet');

select is((select count(*)::int from public.memories), 4, 'Alice sees only her 4 memories');
select is((select user_id from public.memories where content = 'Habite à Paris'),
  'aaaaaaaa-0000-0000-0000-0000000000a4'::uuid, 'user_id defaults to the caller');

-- isolation and constraints
select throws_ok($$ insert into public.memories (workspace_id, content) select bob_ws, 'x' from ids $$,
  '42501', null, 'Alice cannot write into Bob''s workspace');
select throws_ok($$ insert into public.memories (workspace_id, user_id, content)
                    select alice_ws, 'bbbbbbbb-0000-0000-0000-0000000000b4', 'x' from ids $$,
  '42501', null, 'Alice cannot set the memory owner');
select is_empty($$ update public.memories set content = 'pirate' where id = (select bob_mem from ids) returning id $$,
  'Alice cannot edit Bob''s memory');
select is_empty($$ delete from public.memories where id = (select bob_mem from ids) returning id $$,
  'Alice cannot delete Bob''s memory');
select throws_ok($$ insert into public.memories (workspace_id, content) select alice_ws, repeat('x', 501) from ids $$,
  '23514', null, 'memory content is capped at 500 characters');
select throws_ok($$ insert into public.memories (workspace_id, content) select alice_ws, '   ' from ids $$,
  '23514', null, 'blank memories are rejected');
select throws_ok($$ insert into public.memories (workspace_id, content, kind) select alice_ws, 'x', 'instruction' from ids $$,
  '23514', null, 'unknown kinds are rejected');
select throws_ok($$ insert into public.memories (workspace_id, content, embedding)
                    select alice_ws, 'x', pg_temp.vec(1) from ids $$,
  '23514', null, 'an embedding must name its model');
select throws_ok($$ insert into public.memories (workspace_id, content, source_message_id)
                    select alice_ws, 'x', bob_msg from ids $$,
  '23514', null, 'a memory cannot cite Bob''s message');
select throws_ok($$ insert into public.memories (workspace_id, content, source_message_id)
                    select alice_ws, 'x', alice_reply from ids $$,
  '23514', null, 'a memory cannot cite an assistant message (users can forge those)');
select throws_ok($$ update public.memories set status = 'superseded', superseded_by = (select bob_mem from ids)
                    where id = (select id from public.memories where content like 'Habite à Paris%') $$,
  '23514', null, 'a memory cannot be superseded by Bob''s memory');
select throws_ok($$ update public.memories set user_id = 'bbbbbbbb-0000-0000-0000-0000000000b4' $$,
  '42501', null, 'the owner column is not updatable');

-- editing the text drops the stale vector
update public.memories set content = 'Habite à Paris 11e' where id = (select id from public.memories where content like 'Habite à Paris%');
select ok((select embedding is null and embedding_model is null from public.memories
           where id = (select id from public.memories where content like 'Habite à Paris%')), 'editing the text clears the stale embedding');
update public.memories set embedding = pg_temp.vec(2), embedding_model = 'test-embed'
  where id = (select id from public.memories where content like 'Habite à Paris%');

-- ---- hybrid recall
select is((select array_agg(content order by score desc) from public.match_memories('pizza')),
  array['Préfère les pizzas napolitaines'], 'lexical recall ignores case, accents and Bob''s rows');
select is((select content from public.match_memories('Quel est mon plat préféré ?') limit 1),
  'Préfère les pizzas napolitaines', 'stemming: "préféré" finds "Préfère"');
select is((select content from public.match_memories('qu''est-ce que je mange ce soir',
             pg_temp.vec(1, 4, 0.3), 'test-embed')),
  'Préfère les pizzas napolitaines', 'semantic recall without any shared word');
select is((select count(*)::int from public.match_memories('bonjour', pg_temp.vec(5), 'test-embed')), 0,
  'an unrelated embedding recalls nothing (distance threshold)');
select is((select count(*)::int from public.match_memories('pizza', pg_temp.vec(1), 'other-model')), 1,
  'vectors of another model are never compared (lexical match only)');
select is((select content from public.match_memories('ville Paris', pg_temp.vec(2, 3, 0.4), 'test-embed') limit 1),
  'Habite à Paris 11e', 'a memory found by both lists ranks first');
select ok((select lexical_rank = 1 and semantic_rank = 1
           from public.match_memories('ville Paris', pg_temp.vec(2, 3, 0.4), 'test-embed') limit 1),
  'fused rows report both ranks');

-- ---- contradiction: Lyon supersedes Paris
insert into public.memories (workspace_id, content, embedding, embedding_model)
  select alice_ws, 'Habite à Lyon depuis 2026', pg_temp.vec(2), 'test-embed' from ids;
update public.memories set status = 'superseded', superseded_by = (select id from public.memories where content like 'Habite à Lyon%')
  where id = (select id from public.memories where content like 'Habite à Paris%');
select is((select array_agg(content) from public.match_memories('Où est-ce que j''habite ?', pg_temp.vec(2), 'test-embed')),
  array['Habite à Lyon depuis 2026'], 'a superseded memory is never recalled');

-- deleting the newer memory keeps the old one (history), detached
delete from public.memories where id = (select id from public.memories where content like 'Habite à Lyon%');
select is((select superseded_by from public.memories where id = (select id from public.memories where content like 'Habite à Paris%')), null,
  'deleting the replacement detaches the superseded memory');

-- ---- conversation summaries
select lives_ok($$ update public.conversations set summary = 'Résumé', summary_until = now()
                   where id = (select alice_conv from ids) $$, 'Alice stores a conversation summary');
select throws_ok($$ update public.conversations set summary_until = null where id = (select alice_conv from ids) $$,
  '23514', null, 'a summary always records the last message it covers');

select * from finish();
rollback;
