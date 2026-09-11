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

  -- {from, to, retired} when this folder is a trip, null when it is not. A
  -- trip is already a property of a folder in the browser, so it wants a
  -- column here and not a table of its own.
  trip        jsonb,

  -- Item tombstones: {id, at} for each waypoint removed, beside the items
  -- rather than inside them. Co-editing has to tell "the other person deleted
  -- this" from "this device has not seen it yet", which absence cannot say.
  -- Inside `items` they would be every reader's problem - the map, GPX, KML,
  -- export - and here they are nobody's but sync's.
  removed_items jsonb not null default '[]'::jsonb,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (user_id, client_id)
);

create index if not exists folders_user_idx on public.folders (user_id, updated_at desc);

-- Added after the table shipped, so an existing install gets the column by
-- running this file again rather than by dropping anything.
alter table public.folders add column if not exists parent_id text;
alter table public.folders add column if not exists trip jsonb;
alter table public.folders add column if not exists removed_items jsonb not null default '[]'::jsonb;

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

-- Belt and braces on insert: even if a client sends someone else's user_id,
-- stamp the row with the authenticated user. The policy above would reject it
-- anyway.
--
-- An update never changes hands. This stamped user_id on insert and update
-- alike, which was harmless while only an owner could write, because the value
-- it wrote back was the one already there. The moment a collaborator can
-- update, that same line hands them the folder: it would leave the owner's
-- account on the collaborator's first edit and arrive in theirs, silently,
-- with the owner's copy simply gone.
--
-- Filing and deletion stay with the owner for the same reason. A collaborator
-- edits what is in a folder, not whether the owner still has it or where they
-- keep it. A WITH CHECK cannot express that, because it cannot see the row as
-- it was; here the old row is in hand, so it can.
create or replace function public.folders_set_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
  else
    new.user_id := old.user_id;
    if auth.uid() is distinct from old.user_id then
      new.parent_id := old.parent_id;
      new.deleted := old.deleted;
      new.created_at := old.created_at;
    end if;
  end if;
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

  -- What the invitation allows: 'viewer' to look, 'editor' to work on it too.
  -- Defaulted to the narrower of the two, so an invitation written by anything
  -- that has not heard of this column grants what it always granted.
  role           text not null default 'viewer',

  -- Revoked rather than deleted, so "this was shared and then withdrawn" is
  -- distinguishable from "never shared".
  revoked        boolean not null default false,

  created_at     timestamptz not null default now(),

  unique (owner_id, client_id, invited_email)
);

create index if not exists folder_shares_invited_idx
  on public.folder_shares (lower(invited_email)) where not revoked;

alter table public.folder_shares add column if not exists role text not null default 'viewer';
alter table public.folder_shares drop constraint if exists folder_shares_role_check;
alter table public.folder_shares add constraint folder_shares_role_check
  check (role in ('viewer', 'editor'));

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

-- And a folder shared for editing becomes writable by them, which being able
-- to read it never implied.
--
-- Again a separate policy: an invitation that does not say 'editor' grants
-- exactly what it granted before this existed. Insert and delete stay with the
-- owner, so a collaborator can change what is in a folder and cannot create
-- one in somebody else's name or remove theirs.
drop policy if exists "a co-edited folder is writable by whoever it names" on public.folders;
create policy "a co-edited folder is writable by whoever it names"
  on public.folders
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.folder_shares s
      where s.owner_id = folders.user_id
        and s.client_id = folders.client_id
        and not s.revoked
        and s.role = 'editor'
        and lower(s.invited_email) = lower(auth.jwt() ->> 'email')
    )
  )
  with check (
    exists (
      select 1
      from public.folder_shares s
      where s.owner_id = folders.user_id
        and s.client_id = folders.client_id
        and not s.revoked
        and s.role = 'editor'
        and lower(s.invited_email) = lower(auth.jwt() ->> 'email')
    )
  );

-- ----------------------------------------------------------- entitlements
--
-- What an account is entitled to, decided where the browser cannot reach.
--
-- assets/js/lib/tiers.js says at the top that it is not a permission boundary,
-- and means it: anybody can set their tier in devtools in about four seconds.
-- This is the other half, and the half that counts.

-- Only explicit grants are stored. The trial is not, because it is already
-- knowable: an account's thirtieth day is thirty days after the day it was
-- created, and a stored copy of that is a second answer that can disagree with
-- the first. Nothing to write on signup, nothing to backfill, nothing to drift.
create table if not exists public.entitlements (
  user_id     uuid primary key references auth.users (id) on delete cascade,

  tier        text not null default 'premium',

  -- Where it came from, so a subscription that lapses is distinguishable from
  -- something given by hand and never meant to end.
  source      text not null default 'granted',

  -- Null means it does not expire. That is the administrator case.
  expires_at  timestamptz,

  note        text not null default '',
  updated_at  timestamptz not null default now()
);

alter table public.entitlements drop constraint if exists entitlements_tier_check;
alter table public.entitlements add constraint entitlements_tier_check
  check (tier in ('free', 'premium'));
alter table public.entitlements drop constraint if exists entitlements_source_check;
alter table public.entitlements add constraint entitlements_source_check
  check (source in ('granted', 'appstore', 'comp'));

alter table public.entitlements enable row level security;

-- Readable by the person it is about, and writable by nobody.
--
-- There is deliberately no insert, update or delete policy. With row-level
-- security on and no policy for a command, that command is refused for every
-- signed-in user, so the only thing that can write here is the service role: a
-- migration, or an Edge Function holding the secret key. That is the entire
-- point of the table, and it is worth checking rather than assuming - see
-- rls-probe.sql.
drop policy if exists "your own entitlement is readable by you" on public.entitlements;
create policy "your own entitlement is readable by you"
  on public.entitlements
  for select
  to authenticated
  using (auth.uid() = user_id);

-- The one question worth asking, answered for the caller and nobody else.
--
-- It takes no argument on purpose. A plan_for(uid) would let any signed-in
-- account ask about any other, which is not worth handing out to save a
-- keystroke. Reading auth.users is why it is SECURITY DEFINER, and auth.uid()
-- is the only row it ever reads.
--
-- Precedence is grant, then trial, then free. A grant that has expired falls
-- back to the trial rather than straight to free, which matters only in the
-- first month of an account and is the answer somebody would expect if it did.
create or replace function public.my_plan()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with granted as (
    select tier, source, expires_at
    from public.entitlements
    where user_id = auth.uid()
      and tier = 'premium'
      and (expires_at is null or expires_at > now())
    limit 1
  ),
  trial as (
    -- Thirty days from the day the account was made. One place, one interval.
    select u.created_at + interval '30 days' as ends
    from auth.users u
    where u.id = auth.uid()
  )
  select case
    when exists (select 1 from granted) then jsonb_build_object(
      'tier', 'premium',
      'source', (select source from granted),
      'until', (select expires_at from granted)
    )
    when (select ends from trial) > now() then jsonb_build_object(
      'tier', 'premium',
      'source', 'trial',
      'until', (select ends from trial)
    )
    else jsonb_build_object('tier', 'free', 'source', 'none', 'until', null)
  end;
$$;

revoke execute on function public.my_plan() from anon;
grant execute on function public.my_plan() to authenticated;

-- Whoever runs the service, premium with no end date. Edit the address, or add
-- rows here for anybody else who should have it: this is what "code it into the
-- database" means, and it is one row rather than a special case in the app.
insert into public.entitlements (user_id, tier, source, expires_at, note)
select id, 'premium', 'granted', null, 'Runs the service.'
from auth.users where lower(email) = 'shermancahal@gmail.com'
on conflict (user_id) do update
  set tier = 'premium', source = 'granted', expires_at = null, updated_at = now();

-- ---------------------------------------------------------------- support
--
-- Mail written to support@halfstop.app, as a queue one person works through.
--
-- Not linked to auth.users on purpose: most people writing to support have no
-- account, and the ones who do may write from a different address than the one
-- they signed up with.
create table if not exists public.support_tickets (
  id           uuid primary key default gen_random_uuid(),
  received_at  timestamptz not null default now(),

  from_email   text not null default '',
  from_name    text not null default '',
  subject      text not null default '',
  body         text not null default '',

  -- new, open, done. Text rather than an enum so adding one is not a migration.
  status       text not null default 'new',
  note         text not null default '',

  -- 'email' from the inbound webhook, 'manual' for a row typed in by hand.
  source       text not null default 'email',
  -- The provider's own id. Null for a ticket that did not come from a
  -- provider, because the unique index below is what makes a redelivery
  -- recognisable and Postgres lets nulls repeat.
  external_id  text,

  updated_at   timestamptz not null default now()
);

create index if not exists support_tickets_queue_idx
  on public.support_tickets (status, received_at desc);

-- Resend retries a delivery it could not confirm, so the same message can
-- arrive twice. Without this the queue grows a second copy of it, which is
-- worse than a missed ticket because it looks like a second person wrote in.
-- The alters are here rather than in a migration because the table shipped
-- with this column not-null and defaulted to the empty string, which would
-- collide the moment a ticket was typed in by hand.
alter table public.support_tickets alter column external_id drop not null;
alter table public.support_tickets alter column external_id drop default;
update public.support_tickets set external_id = null where external_id = '';
create unique index if not exists support_tickets_external_id_key
  on public.support_tickets (external_id);

alter table public.support_tickets enable row level security;

-- One address, checked server-side.
--
-- admin.html hides itself from everybody else, and hiding a page stops an
-- accident rather than an attacker. This is the part that decides, and it
-- reads the signed-in email as the server sees it rather than anything the
-- browser sent. Rows are written by the inbound function with the service key,
-- which is not subject to this policy.
drop policy if exists "support is for the administrator" on public.support_tickets;
create policy "support is for the administrator"
  on public.support_tickets
  for all
  to authenticated
  using (lower(auth.jwt() ->> 'email') = 'shermancahal@gmail.com')
  with check (lower(auth.jwt() ->> 'email') = 'shermancahal@gmail.com');
