-- Phase 4: long-term memory (hybrid lexical + vector search, supersession of contradicted
-- facts) and rolling conversation summaries for the Context Engine.
-- As in Phase 3, clients can reach these tables through PostgREST with their JWT: the
-- database is the validation boundary, the API is a convenience.

create extension if not exists vector with schema extensions;
create extension if not exists unaccent with schema extensions;

-- Accent- and case-insensitive French search ("préféré" matches "prefere"), stop words
-- removed. One fixed configuration so the generated column stays immutable.
create text search configuration private.leana_search (copy = pg_catalog.french);
alter text search configuration private.leana_search
  alter mapping for hword, hword_part, word with extensions.unaccent, french_stem;

-- Embedding width shared by every provider (Gemini and OpenRouter models are asked for 768
-- dimensions). Changing it needs a migration and a re-embedding of all rows.
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null default 'fact' check (kind in ('fact', 'preference', 'goal', 'relationship')),
  content text not null check (char_length(btrim(content)) between 1 and 500),
  importance smallint not null default 3 check (importance between 1 and 5),
  -- 'conversation' = extracted by the assistant from one of the user's own messages.
  source text not null default 'manual' check (source in ('manual', 'conversation')),
  source_message_id uuid references public.messages (id) on delete set null,
  -- A contradicted memory is kept (history, undo) but never recalled again.
  status text not null default 'active' check (status in ('active', 'superseded')),
  superseded_by uuid references public.memories (id) on delete set null,
  embedding extensions.vector(768),
  embedding_model text check (char_length(embedding_model) between 1 and 100),
  fts tsvector generated always as (to_tsvector('private.leana_search', content)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A vector is only comparable with vectors of the same model.
  check ((embedding is null) = (embedding_model is null)),
  check (superseded_by is null or status = 'superseded'),
  check (superseded_by is distinct from id)
);
create index memories_user_status_idx on public.memories (user_id, status, updated_at desc);
create index memories_workspace_idx on public.memories (workspace_id);
create index memories_source_message_idx on public.memories (source_message_id);
create index memories_superseded_by_idx on public.memories (superseded_by);
create index memories_fts_idx on public.memories using gin (fts);
-- No ANN (HNSW) index on purpose: recall is always filtered to one user's few hundred rows,
-- which the btree above narrows first, and an exact scan is then both fast and exact.
-- An ANN index with per-user filters would need pgvector iterative scans to stay correct.

create trigger memories_updated_at before update on public.memories
  for each row execute function private.set_updated_at();

-- New text = stale vector, unless the same update provides the new one.
-- References must point to the caller's own rows: foreign keys bypass RLS, this does not
-- (security invoker, so the lookups below go through RLS).
create function private.check_memory() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.content is distinct from old.content
     -- vector has no IS DISTINCT FROM support with an empty search_path: compare as text.
     and new.embedding::text is not distinct from old.embedding::text then
    new.embedding := null;
    new.embedding_model := null;
  end if;
  if new.source_message_id is not null
     and (tg_op = 'INSERT' or new.source_message_id is distinct from old.source_message_id)
     and not exists (
       select 1 from public.messages m
       where m.id = new.source_message_id and m.user_id = new.user_id and m.role = 'user'
     ) then
    raise exception 'source_message_id must be one of your own user messages'
      using errcode = '23514';
  end if;
  if new.superseded_by is not null
     and (tg_op = 'INSERT' or new.superseded_by is distinct from old.superseded_by)
     and not exists (
       select 1 from public.memories m
       where m.id = new.superseded_by and m.user_id = new.user_id
     ) then
    raise exception 'superseded_by must be one of your own memories' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger memories_check before insert or update on public.memories
  for each row execute function private.check_memory();

-- Lexical side of recall: any meaningful word of the question may match (OR, prefix),
-- because a chat message rarely contains all the words of the stored fact.
create function private.memory_query(q text) returns tsquery
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(
    -- Lexemes are already normalized (stemmed, unaccented): 'simple' keeps them as-is.
    (select pg_catalog.to_tsquery(
              'pg_catalog.simple',
              pg_catalog.string_agg(pg_catalog.quote_literal(t.lexeme) || ':*', ' | '))
     from pg_catalog.unnest(pg_catalog.to_tsvector('private.leana_search', left(q, 2000))) t
     where pg_catalog.length(t.lexeme) >= 3),
    ''::tsquery);
$$;
revoke execute on function private.memory_query from public;
grant execute on function private.memory_query to authenticated;

/*
  Hybrid recall over the caller's active memories, fused with Reciprocal Rank Fusion
  (k = 60): each list contributes 1 / (60 + rank). Rows found by both lists come first.
  Semantic matches are limited to vectors of `embedding_model` closer than `max_distance`
  (cosine distance), so an unrelated memory is not recalled just because it is the nearest.
  Without an embedding the search is lexical only. security invoker: RLS scopes rows.
*/
create function public.match_memories(
  query_text text,
  query_embedding extensions.vector(768) default null,
  embedding_model text default null,
  match_count integer default 8,
  max_distance double precision default 0.5,
  workspace uuid default null
)
returns table (
  id uuid,
  kind text,
  content text,
  importance smallint,
  source text,
  created_at timestamptz,
  updated_at timestamptz,
  score double precision,
  lexical_rank integer,
  semantic_rank integer,
  distance double precision
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
    where m.user_id = (select auth.uid())
      and m.status = 'active'
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
    where query_embedding is not null
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (workspace is null or m.workspace_id = workspace)
      and m.embedding_model = match_memories.embedding_model
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
revoke execute on function public.match_memories from public, anon;
grant execute on function public.match_memories to authenticated;

-- ---------------------------------------------------------------- conversation summaries
-- Rolling summary of the turns that no longer fit in the context window. Written by the
-- API with the user's JWT, so a user can only ever alter their own model context.
alter table public.conversations
  add column summary text check (char_length(summary) <= 8000),
  -- created_at of the newest message covered by `summary`.
  add column summary_until timestamptz,
  add check ((summary is null) = (summary_until is null));
grant update (summary, summary_until) on public.conversations to authenticated;

-- ---------------------------------------------------------------- RLS + grants

alter table public.memories enable row level security;
revoke all on public.memories from anon, authenticated;

-- memories: private to their author, and only while they belong to the workspace.
grant select (id, workspace_id, user_id, kind, content, importance, source, source_message_id,
              status, superseded_by, embedding, embedding_model, fts, created_at, updated_at),
      insert (workspace_id, kind, content, importance, source, source_message_id, status,
              superseded_by, embedding, embedding_model),
      update (kind, content, importance, status, superseded_by, embedding, embedding_model),
      delete
  on public.memories to authenticated;
create policy "memories: read own" on public.memories for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "memories: create own" on public.memories for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "memories: update own" on public.memories for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "memories: delete own" on public.memories for delete to authenticated
  using (user_id = (select auth.uid()));

-- ai_usage also records embedding calls (provider = the embeddings vendor).
alter table public.ai_usage add column kind text not null default 'chat'
  check (kind in ('chat', 'memory', 'summary', 'embedding'));
grant insert (kind) on public.ai_usage to authenticated;
