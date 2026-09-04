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
