-- Phase 3: assistant conversations, messages and an append-only AI usage ledger.
-- Clients can reach these tables through PostgREST with their JWT, so every writable
-- column is constrained here; API-side validation is a convenience, not the boundary.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text check (char_length(btrim(title)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_recent_idx on public.conversations (user_id, updated_at desc);
create index conversations_workspace_idx on public.conversations (workspace_id);

-- Note: rows are written with the user's JWT, so a user can insert role='assistant' rows
-- into their own conversations. Later phases must not treat stored assistant turns as
-- server-authored (memory extraction, missions) without a server-side signature.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 32000),
  status text not null default 'complete' check (status in ('complete', 'error', 'interrupted')),
  model text check (char_length(model) <= 64),
  error_code text check (char_length(error_code) <= 32),
  created_at timestamptz not null default clock_timestamp()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_user_idx on public.messages (user_id);

-- Ledger used for per-user quotas: insert + read only, so spend can never be erased.
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  model text not null check (char_length(model) between 1 and 64),
  input_tokens integer not null check (input_tokens between 0 and 10000000),
  output_tokens integer not null check (output_tokens between 0 and 10000000),
  -- true when the provider never reported usage (stopped, timed out or failed mid-answer)
  -- and the API recorded an estimate, so the quota cannot be dodged with "Stop".
  estimated boolean not null default false,
  created_at timestamptz not null default now()
);
create index ai_usage_user_recent_idx on public.ai_usage (user_id, created_at desc);
create index ai_usage_conversation_idx on public.ai_usage (conversation_id);

create trigger conversations_updated_at before update on public.conversations
  for each row execute function private.set_updated_at();

-- A new message bumps its conversation (for "recent first" ordering). security definer
-- because users may only update `title`; the message insert already passed RLS.
create function private.touch_conversation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$;
create trigger messages_touch_conversation after insert on public.messages
  for each row execute function private.touch_conversation();

-- Tokens spent by the caller since a point in time (quota check). security invoker: RLS
-- limits the sum to the caller's own rows; aggregating in SQL avoids PostgREST row caps.
create function public.ai_tokens_used_since(since timestamptz) returns bigint
language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(u.input_tokens + u.output_tokens), 0)::bigint
  from public.ai_usage u
  where u.user_id = (select auth.uid()) and u.created_at >= since;
$$;
revoke execute on function public.ai_tokens_used_since from public, anon;
grant execute on function public.ai_tokens_used_since to authenticated;

-- ---------------------------------------------------------------- RLS + grants

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_usage enable row level security;

revoke all on public.conversations, public.messages, public.ai_usage from anon, authenticated;

-- conversations: private to their author, and only while they belong to the workspace.
grant select, insert (workspace_id, title), update (title), delete
  on public.conversations to authenticated;
create policy "conversations: read own" on public.conversations for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "conversations: create own" on public.conversations for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));
create policy "conversations: rename own" on public.conversations for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "conversations: delete own" on public.conversations for delete to authenticated
  using (user_id = (select auth.uid()));

-- messages: immutable once written; removed with their conversation.
grant select, insert (conversation_id, role, content, status, model, error_code)
  on public.messages to authenticated;
create policy "messages: read own" on public.messages for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (select 1 from public.conversations c where c.id = conversation_id)
  );
create policy "messages: append to own conversation" on public.messages for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.conversations c where c.id = conversation_id)
  );

-- ai_usage: append-only ledger.
grant select, insert (conversation_id, model, input_tokens, output_tokens, estimated)
  on public.ai_usage to authenticated;
create policy "ai_usage: read own" on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()));
create policy "ai_usage: append own" on public.ai_usage for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (conversation_id is null
         or exists (select 1 from public.conversations c where c.id = conversation_id))
  );
