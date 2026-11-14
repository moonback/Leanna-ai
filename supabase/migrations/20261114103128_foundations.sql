-- Phase 2 foundations: profiles, workspaces, memberships, preferences, consents.
-- Every public table has RLS enabled and explicit grants (anon gets nothing).

create schema if not exists private;
grant usage on schema private to authenticated;

-- Ordered so that `role >= 'admin'` means admin or owner.
create type public.workspace_role as enum ('member', 'admin', 'owner');

-- ---------------------------------------------------------------- helpers

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  avatar_url text check (avatar_url ~ '^https://'),
  locale text not null default 'fr' check (locale in ('fr', 'en')),
  timezone text not null default 'Europe/Paris' check (char_length(timezone) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspaces_created_by_idx on public.workspaces (created_by);

create table public.memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

create table public.preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  default_workspace_id uuid references public.workspaces (id) on delete set null,
  settings jsonb not null default '{}'
    check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 16384),
  updated_at timestamptz not null default now()
);
create index preferences_default_workspace_idx on public.preferences (default_workspace_id);

-- Append-only consent log (GDPR proof): the latest row per kind is the current state.
create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('terms', 'privacy', 'ai_processing', 'marketing')),
  granted boolean not null,
  policy_version text not null check (char_length(policy_version) between 1 and 32),
  created_at timestamptz not null default now()
);
create index consents_user_kind_idx on public.consents (user_id, kind, created_at desc);

-- Clients can reach PostgREST directly, so the database is the real validation boundary.
create function private.validate_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger profiles_validate_timezone before insert or update of timezone on public.profiles
  for each row execute function private.validate_timezone();

create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();
create trigger preferences_updated_at before update on public.preferences
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- access helpers
-- security definer so membership checks do not recurse through memberships RLS.
-- Lives in `private` (not exposed by the Data API) and only ever checks auth.uid().

create function private.has_workspace_role(ws uuid, min_role public.workspace_role)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role >= min_role
  );
$$;
revoke execute on function private.has_workspace_role from public;
grant execute on function private.has_workspace_role to authenticated;

-- ---------------------------------------------------------------- lifecycle triggers

-- New account: profile, personal workspace (owner), preferences.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws_id uuid;
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 80));

  insert into public.workspaces (name, created_by)
  values ('Espace personnel', new.id)
  returning id into ws_id;

  insert into public.memberships (workspace_id, user_id, role) values (ws_id, new.id, 'owner')
  on conflict (workspace_id, user_id) do update set role = 'owner';
  insert into public.preferences (user_id, default_workspace_id) values (new.id, ws_id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Account deletion (GDPR): drop workspaces the user is the only member of.
-- Rows owned by the user elsewhere cascade through the auth.users foreign keys.
create function private.handle_user_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.workspaces w
  where w.id in (select workspace_id from public.memberships where user_id = old.id)
    and not exists (
      select 1 from public.memberships m where m.workspace_id = w.id and m.user_id <> old.id
    );
  return old;
end;
$$;
create trigger on_auth_user_deleted before delete on auth.users
  for each row execute function private.handle_user_deleted();

-- A workspace created by a signed-in user gets that user as owner.
create function private.handle_new_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null then
    insert into public.memberships (workspace_id, user_id, role)
    values (new.id, (select auth.uid()), 'owner')
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger on_workspace_created after insert on public.workspaces
  for each row execute function private.handle_new_workspace();

-- ---------------------------------------------------------------- RLS + grants

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.preferences enable row level security;
alter table public.consents enable row level security;

revoke all on public.profiles, public.workspaces, public.memberships, public.preferences,
  public.consents from anon, authenticated;

-- profiles: own row only (created by trigger, removed with the account).
-- shortcut: co-members cannot see each other's profile yet; widen when sharing ships.
grant select, update (display_name, avatar_url, locale, timezone) on public.profiles to authenticated;
create policy "profiles: read own" on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- workspaces: members read, admins rename, owners delete, signed-in users create their own.
grant select, insert (name), update (name), delete on public.workspaces to authenticated;
-- The second clause lets `insert ... returning` succeed: RETURNING is checked before the
-- AFTER trigger adds the owner membership. It only holds inside the creating transaction.
create policy "workspaces: members read" on public.workspaces for select to authenticated
  using (
    private.has_workspace_role(id, 'member')
    or (created_by = (select auth.uid()) and created_at = now())
  );
create policy "workspaces: create own" on public.workspaces for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy "workspaces: admins update" on public.workspaces for update to authenticated
  using (private.has_workspace_role(id, 'admin'))
  with check (private.has_workspace_role(id, 'admin'));
create policy "workspaces: owners delete" on public.workspaces for delete to authenticated
  using (private.has_workspace_role(id, 'owner'));

-- memberships: members see the roster; a non-owner may leave. Invitations come later.
grant select, delete on public.memberships to authenticated;
create policy "memberships: members read" on public.memberships for select to authenticated
  using (private.has_workspace_role(workspace_id, 'member'));
create policy "memberships: leave" on public.memberships for delete to authenticated
  using (user_id = (select auth.uid()) and role <> 'owner');

-- preferences: own row; the default workspace must be one the user belongs to.
grant select, update (default_workspace_id, settings) on public.preferences to authenticated;
create policy "preferences: read own" on public.preferences for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "preferences: update own" on public.preferences for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (default_workspace_id is null or private.has_workspace_role(default_workspace_id, 'member'))
  );

-- consents: append-only, own rows.
grant select, insert (kind, granted, policy_version) on public.consents to authenticated;
create policy "consents: read own" on public.consents for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "consents: append own" on public.consents for insert to authenticated
  with check ((select auth.uid()) = user_id);
