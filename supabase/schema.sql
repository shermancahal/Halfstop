-- Halfstop — Supabase schema
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.
-- Safe to run again; every statement is guarded.

create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,

  -- The id the browser generated. Sync matches on (user_id, client_id) so a
  -- folder keeps its identity across devices without the client needing to
  -- know the database's own primary key.
  client_id   text not null,

  name        text not null,
  color       text,

  -- The client_id of the folder this one is filed under, or null at the top.
  -- Not a foreign key: sync pushes folders one at a time and in no particular
  -- order, so a child can arrive before its parent does, and a constraint here
  -- would reject it rather than let the tree settle a moment later.
  parent_id   text,

  visible     boolean not null default true,
  collapsed   boolean not null default false,

  -- A deleted folder is kept as a tombstone rather than removed. Sync cannot
  -- otherwise tell "deleted on another device" from "this device has never
  -- seen it", and guessing wrong deletes the user's data.
  deleted     boolean not null default false,

  -- Waypoints and tracks, in the same shape the browser stores. Photos are not
  -- included: their bytes stay on the device, and only ids travel.
  items       jsonb not null default '[]'::jsonb,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (user_id, client_id)
);

create index if not exists folders_user_idx on public.folders (user_id, updated_at desc);

-- Added after the table shipped, so an existing install gets the column by
-- running this file again rather than by dropping anything.
alter table public.folders add column if not exists parent_id text;

-- Row-level security. Without this every signed-in user could read every other
-- user's folders, since the publishable key is by design public.
alter table public.folders enable row level security;

drop policy if exists "folders are private to their owner" on public.folders;
create policy "folders are private to their owner"
  on public.folders
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Belt and braces: even if a client sends someone else's user_id, stamp the
-- row with the authenticated user. The policy above would reject it anyway.
create or replace function public.folders_set_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := auth.uid();
  new.updated_at := coalesce(new.updated_at, now());
  return new;
end;
$$;

drop trigger if exists folders_set_owner_trigger on public.folders;
create trigger folders_set_owner_trigger
  before insert or update on public.folders
  for each row execute function public.folders_set_owner();

-- A trigger function has no business being callable as an endpoint.
--
-- Anything in the public schema is exposed over PostgREST as an RPC, and this
-- one is SECURITY DEFINER - so it was listed at /rest/v1/rpc/folders_set_owner
-- for anybody with the publishable key. Calling it outside a trigger errors on
-- the missing `new` record rather than doing damage, which is luck rather than
-- design. Supabase's own linter flags it; this is the fix it asks for.
revoke execute on function public.folders_set_owner() from anon, authenticated;

-- ---------------------------------------------------------------- sharing
--
-- A folder shared with somebody, by the address they will sign in with.
--
-- The address is the grant, deliberately, rather than a token in a link. A
-- bearer link is forwardable: one "look at this" to a group chat and a folder
-- of somebody's saved places is public. Matching on the signed-in email means
-- a forwarded invitation is useless to anybody but the person it names.
create table if not exists public.folder_shares (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,

  -- The folder, in the owner's own namespace - the same client_id the folders
  -- table is keyed by. Not a foreign key for the same reason parent_id is not:
  -- the row can be written before the folder has been pushed.
  client_id      text not null,

  -- Lower-cased on the way in, because an invitation to Sherm@example.com has
  -- to match a session that says sherm@example.com.
  invited_email  text not null,

  -- What the invitation said, kept so the list can be drawn without another
  -- lookup and so a rename does not rewrite history.
  folder_name    text not null default '',
  invited_by     text not null default '',

  -- Revoked rather than deleted, so "this was shared and then withdrawn" is
  -- distinguishable from "never shared".
  revoked        boolean not null default false,

  created_at     timestamptz not null default now(),

  unique (owner_id, client_id, invited_email)
);

create index if not exists folder_shares_invited_idx
  on public.folder_shares (lower(invited_email)) where not revoked;

alter table public.folder_shares enable row level security;

-- The owner manages their own invitations.
drop policy if exists "an owner manages their own shares" on public.folder_shares;
create policy "an owner manages their own shares"
  on public.folder_shares
  for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- The person invited may read the invitation addressed to them, which is how
-- the app knows what to show them. Reading it grants nothing on its own.
drop policy if exists "an invitation is readable by the person it names" on public.folder_shares;
create policy "an invitation is readable by the person it names"
  on public.folder_shares
  for select
  to authenticated
  using (not revoked and lower(invited_email) = lower(auth.jwt() ->> 'email'));

-- And the folder itself becomes readable to them.
--
-- A second policy rather than a change to the first: policies are OR'd, so
-- this adds a way to SELECT and leaves insert, update and delete exactly as
-- they were - owner only. A reader cannot write to a folder they were shown,
-- and the folders_set_owner trigger would reassign the row to them if they
-- could, which is the accident this arrangement makes impossible.
drop policy if exists "a shared folder is readable by whoever it names" on public.folders;
create policy "a shared folder is readable by whoever it names"
  on public.folders
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.folder_shares s
      where s.owner_id = folders.user_id
        and s.client_id = folders.client_id
        and not s.revoked
        and lower(s.invited_email) = lower(auth.jwt() ->> 'email')
    )
  );
