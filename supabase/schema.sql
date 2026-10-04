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

-- Every policy below wraps auth.uid() and auth.jwt() in a scalar subquery, and
-- that is not decoration.
--
-- Both are STABLE rather than IMMUTABLE, so written bare inside a policy they
-- are re-evaluated once per row: the check on a thousand-row folder list runs
-- a thousand times and returns the same answer a thousand times. Wrapped in
-- `(select ...)` the planner makes it an InitPlan, evaluated once for the
-- statement and reused. The value cannot change mid-statement, so this is the
-- same rule enforced the same way, and only the row count stops mattering.

-- Whether an account holds Premium today, for the rules below.
--
-- Syncing is the part of Halfstop that is paid for, because it is the part
-- that is stored and served every time: every row here is database space and
-- every sync is bandwidth. A free account syncs a small collection - see
-- folders_within_allowance, further down - and Premium syncs any amount. Both
-- ask this for the same thing my_plan() calls premium: a premium row that has
-- not run out.
--
-- A function rather than the subquery written out, because the questions are
-- about the folder's owner, and whoever is writing cannot always read the
-- owner's entitlement: the entitlements policy shows each account its own row
-- and nobody else's, which is right, and which a subquery inside a policy is
-- held to like any other query. SECURITY DEFINER is what lets it look, and
-- all it hands back is one boolean.
--
-- In a schema of its own, which PostgREST does not serve. In public it would
-- be /rest/v1/rpc/holds_premium, and anybody signed in could ask whether any
-- account id pays. authenticated needs USAGE and EXECUTE only so the policies
-- can call it - a policy runs as the account making the request.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

--
-- plpgsql rather than sql only so this file still runs top to bottom on an
-- empty database: a sql function's body is checked when it is created, and
-- public.entitlements is created further down. plpgsql looks the table up
-- when it is called, by which time it is there.
create or replace function private.holds_premium(account uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1
    from public.entitlements e
    where e.user_id = account
      and e.tier = 'premium'
      and (e.expires_at is null or e.expires_at > now())
  );
end;
$$;

revoke execute on function private.holds_premium(uuid) from public;
grant execute on function private.holds_premium(uuid) to authenticated;

-- An owner's folders, one policy per command.
--
-- This was one FOR ALL policy. It is four so each can say what it means, and
-- so a rule about one command cannot land on the others by accident: for a
-- day, insert and update asked for Premium here, and a free account could not
-- sync at all. The plan is now a question of how much, which a policy cannot
-- count, so it lives in the folders_within_allowance trigger below and these
-- are about ownership alone.
--
-- Reading and removing never ask about a plan. A subscription that lapses
-- stops the syncing past the free allowance, not the owning: the FAQ promises
-- nothing is deleted and that getting your own data out is free.
drop policy if exists "folders are private to their owner" on public.folders;
drop policy if exists "an owner on Premium adds folders" on public.folders;
drop policy if exists "an owner on Premium changes their folders" on public.folders;

drop policy if exists "an owner reads their own folders" on public.folders;
create policy "an owner reads their own folders"
  on public.folders
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "an owner removes their own folders" on public.folders;
create policy "an owner removes their own folders"
  on public.folders
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "an owner adds folders" on public.folders;
create policy "an owner adds folders"
  on public.folders
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "an owner changes their folders" on public.folders;
create policy "an owner changes their folders"
  on public.folders
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- How much a free account syncs: 100 folders and 100 waypoints.
--
-- Every item in a folder counts as one - a waypoint, and a track too, however
-- many points it has. Folders and items marked deleted do not count; they are
-- tombstones kept so a deletion can travel, not things anybody is keeping.
-- The same two numbers are FREE_SYNC in assets/js/lib/tiers.js, which is what
-- the app says and checks before it sends anything; test/sync-plan.test.mjs
-- fails if the two copies disagree.
--
-- A trigger, because a policy sees one row and this is a question about all
-- of an account's rows. SECURITY DEFINER because a collaborator writing to a
-- shared folder can see only that folder, and the count is of the owner's.
--
-- Only growth is refused. A write that leaves the account over the allowance
-- but no further over - removing waypoints, deleting a folder, renaming one -
-- goes through, so an account whose Premium has ended can always trim back
-- down, and nothing it already holds is ever what stops it.
--
-- The refusal carries its own SQLSTATE, HSLIM, so the app can tell "over the
-- free allowance" from every other refusal and say which it was.
create or replace function private.folders_within_allowance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  folder_limit constant integer := 100;
  item_limit constant integer := 100;
  other_folders integer;
  other_items integer;
  was_folders integer;
  was_items integer;
  now_folders integer;
  now_items integer;
begin
  -- The service key and migrations carry no session, so there is no plan to
  -- ask about. Nothing signed in reaches here without one: the policies on
  -- this table are all `to authenticated`.
  if auth.uid() is null then return new; end if;
  if private.holds_premium(new.user_id) then return new; end if;

  -- Everything else the owner holds. Rows written earlier in the same
  -- statement are visible here, so a sync that sends every folder in one
  -- request is counted as it goes, not as if each row were the only one.
  select count(*), coalesce(sum(jsonb_array_length(f.items)), 0)
    into other_folders, other_items
  from public.folders f
  where f.user_id = new.user_id
    and f.client_id <> new.client_id
    and not f.deleted;

  now_folders := other_folders + case when new.deleted then 0 else 1 end;
  now_items := other_items + case when new.deleted then 0 else jsonb_array_length(new.items) end;

  if tg_op = 'UPDATE' and not old.deleted then
    was_folders := other_folders + 1;
    was_items := other_items + jsonb_array_length(old.items);
  else
    was_folders := other_folders;
    was_items := other_items;
  end if;

  if (now_folders > folder_limit and now_folders > was_folders)
    or (now_items > item_limit and now_items > was_items) then
    raise exception using
      errcode = 'HSLIM',
      message = format('A free account syncs up to %s folders and %s waypoints.', folder_limit, item_limit),
      detail = format('This would make %s folders and %s waypoints.', now_folders, now_items),
      hint = 'Premium syncs any number.';
  end if;
  return new;
end;
$$;

revoke execute on function private.folders_within_allowance() from public;

-- Named to sort after folders_set_owner_trigger. Triggers on the same event
-- fire in name order, and this has to count against the owner that trigger
-- has already stamped on an insert, not whatever the request claimed.
drop trigger if exists folders_within_allowance_trigger on public.folders;
create trigger folders_within_allowance_trigger
  before insert or update on public.folders
  for each row execute function private.folders_within_allowance();

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

-- A trigger function has no business carrying a grant.
--
-- Anything in the public schema is exposed over PostgREST as an RPC, and this
-- one is SECURITY DEFINER, so the linter reports it at
-- /rest/v1/rpc/folders_set_owner for anybody with the publishable key.
--
-- REVOKE FROM PUBLIC, NOT FROM THE ROLES BY NAME. This said `from anon,
-- authenticated` for two days and the linter went on reporting it, correctly:
-- Postgres grants EXECUTE to PUBLIC by default on every function, anon and
-- authenticated inherit through PUBLIC, and revoking from the two by name
-- takes away a grant they were never relying on. PUBLIC is the one that has to
-- go, and any SECURITY DEFINER function added later wants the same line.
--
-- Nothing was reachable in the meantime: a function returning `trigger` cannot
-- be called directly at all, because Postgres refuses one outside a trigger
-- before any argument is considered. That is the reason the gap was harmless,
-- not a reason to leave the grant in place.
revoke execute on function public.folders_set_owner() from public;

-- The same grant on the event trigger that turns RLS on for new public tables.
-- That function arrived with the project rather than from this file, so the
-- revoke is guarded and does nothing on a database that has no such function.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

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
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

-- The person invited may read the invitation addressed to them, which is how
-- the app knows what to show them. Reading it grants nothing on its own.
drop policy if exists "an invitation is readable by the person it names" on public.folder_shares;
create policy "an invitation is readable by the person it names"
  on public.folder_shares
  for select
  to authenticated
  using (not revoked and lower(invited_email) = lower((select auth.jwt()) ->> 'email'));

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
        and lower(s.invited_email) = lower((select auth.jwt()) ->> 'email')
    )
  );

-- And a folder shared for editing becomes writable by them, which being able
-- to read it never implied.
--
-- Again a separate policy: an invitation that does not say 'editor' grants
-- exactly what it granted before this existed. Insert and delete stay with the
-- owner, so a collaborator can change what is in a folder and cannot create
-- one in somebody else's name or remove theirs.
--
-- Sharing is Premium, and it is the owner's Premium that counts - not the
-- collaborator's, who may be on a free account. Inviting somebody needs it
-- (invite-to-folder asks), and so does their editing: without the owner's
-- half, a free month was a way to set up a folder that a second free account
-- then edits for ever. When the owner's plan lapses the folder stays readable
-- to everybody it was shared with and stops changing for them; the owner can
-- still change it within the free allowance, like any of their own folders.
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
        and lower(s.invited_email) = lower((select auth.jwt()) ->> 'email')
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
        and lower(s.invited_email) = lower((select auth.jwt()) ->> 'email')
    )
    and private.holds_premium(folders.user_id)
  );

-- ----------------------------------------------------------- entitlements
--
-- What an account is entitled to, decided where the browser cannot reach.
--
-- assets/js/lib/tiers.js says at the top that it is not a permission boundary,
-- and means it: anybody can set their tier in devtools in about four seconds.
-- This is the other half, and the half that counts.

-- What this account has today, whatever it came from - a purchase, a grant,
-- or the free month. One row per account, replaced when the plan changes.
--
-- The trial used to be the exception: it was computed from the day the account
-- was made rather than stored, on the grounds that a stored copy is a second
-- answer that can disagree with the first. True, and it bought the wrong
-- thing. A computed trial cannot be declined, started, or ended early, because
-- there is nothing to write - so every account that had ever signed up was
-- inside one whether or not anybody wanted it, and nobody could subscribe
-- during their free month because there was no row to replace. It is a row
-- now, with source 'trial', like every other plan.
create table if not exists public.entitlements (
  user_id     uuid primary key references auth.users (id) on delete cascade,

  tier        text not null default 'premium',

  -- Where it came from, so a subscription that lapses is distinguishable from
  -- something given by hand and never meant to end. 'appstore', 'play' and
  -- 'stripe' are the ones that sell: the App Store and Google Play only
  -- inside the apps, and Stripe for anybody using Halfstop in a browser, who
  -- otherwise has no way to pay at all.
  source      text not null default 'granted',

  -- Whose subscription this is, in the provider's own words: a Stripe
  -- subscription id, a Google Play purchase token, or an App Store original
  -- transaction id. Kept so a later
  -- event can be matched to the row it belongs to, and so a row can be audited
  -- against the provider without guessing. Null for a grant made by hand.
  external_ref text,

  -- Null means it does not expire. That is the administrator case.
  expires_at  timestamptz,

  -- Whether the date above is a renewal or an ending.
  --
  -- Stripe reports a cancelled subscription as `active` right up to the period
  -- end, so expires_at cannot tell the two apart on its own: the row written
  -- for a subscription ending on October 13 is identical to the one written
  -- for a subscription renewing on it, and the app then tells somebody who has
  -- just cancelled that their plan renews on the day it stops. The webhook
  -- fills this from cancel_at_period_end.
  --
  -- Defaults to true, which is the safe direction for a row that predates it:
  -- wrongly promising a renewal is a smaller wrong than wrongly announcing
  -- that somebody's access is ending.
  renews      boolean not null default true,

  note        text not null default '',
  updated_at  timestamptz not null default now()
);

alter table public.entitlements drop constraint if exists entitlements_tier_check;
alter table public.entitlements add constraint entitlements_tier_check
  check (tier in ('free', 'premium'));
alter table public.entitlements drop constraint if exists entitlements_source_check;
alter table public.entitlements add constraint entitlements_source_check
  check (source in ('granted', 'appstore', 'play', 'stripe', 'comp', 'trial'));
alter table public.entitlements add column if not exists external_ref text;
-- Added after the table shipped; see the column comment above.
alter table public.entitlements add column if not exists renews boolean not null default true;

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
  using ((select auth.uid()) = user_id);

-- ------------------------------------------------------------------- trials
--
-- That an account has had its free month. Once, ever.
--
-- Separate from entitlements because entitlements is not a record. That row is
-- overwritten by a purchase and deleted when an administrator sets somebody
-- back to Free, so reading "has this account had its trial" off it would mean
-- the answer went back to no every time it was cleared - and a free month you
-- can have again by cancelling is not a free month, it is the whole product.
--
-- It holds the dates too, even though the entitlement carries the same end
-- date, because by the time anybody asks this table anything the entitlement
-- is gone.
create table if not exists public.trials (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  ends_at    timestamptz not null
);

alter table public.trials enable row level security;

-- Readable by the person it is about, and writable by nobody.
--
-- The same shape as entitlements above, for the same reason: with row-level
-- security on and no policy for insert, update or delete, those commands are
-- refused for every signed-in user, so the only thing that can write here is
-- something holding the secret key. Which is start_trial(), below, and the
-- account tool. Checked rather than assumed - see rls-probe.sql.
drop policy if exists "your own trial is readable by you" on public.trials;
create policy "your own trial is readable by you"
  on public.trials
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- The one question worth asking, answered for the caller and nobody else.
--
-- It takes no argument on purpose. A plan_for(uid) would let any signed-in
-- account ask about any other, which is not worth handing out to save a
-- keystroke.
--
-- SECURITY INVOKER, which it did not used to be. It was DEFINER because it
-- had to read auth.users to work out when the trial ended, and authenticated
-- cannot read auth.users. It does not read it any more - a trial is a row in
-- the two tables above, both of which let somebody read their own - so the
-- definer's privileges were the only thing left that it was not using, and a
-- function that does not need them should not have them. The execute grants
-- below still matter and are unchanged.
--
-- It answers two things. What this account holds, and - when it holds nothing
-- - whether the free month is still there to be taken. The second is not
-- derivable from the first: Free with a trial still to take and Free with one
-- already spent are the same plan and a different offer, and the interface
-- draws a button on the difference.
create or replace function public.my_plan()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with held as (
    select tier, source, expires_at, renews
    from public.entitlements
    where user_id = (select auth.uid())
      and tier = 'premium'
      and (expires_at is null or expires_at > now())
    limit 1
  ),
  offered as (
    -- Both halves, and they are not the same test. The trials row is what
    -- survives an entitlement being cleared, so it is what stops a second
    -- trial; the entitlements row stops one being started on top of something
    -- already held, which start_trial() refuses anyway.
    select not exists (select 1 from public.trials where user_id = (select auth.uid()))
       and not exists (select 1 from public.entitlements where user_id = (select auth.uid()))
       as available
  )
  select case
    when exists (select 1 from held) then jsonb_build_object(
      'tier', 'premium',
      'source', (select source from held),
      'until', (select expires_at from held),
      'renews', (select renews from held),
      'trialAvailable', false
    )
    else jsonb_build_object(
      'tier', 'free',
      'source', 'none',
      'until', null,
      'renews', false,
      'trialAvailable', (select available from offered)
    )
  end;
$$;

-- From PUBLIC, not only from anon.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and anon inherits that,
-- so revoking from anon alone leaves the PUBLIC grant sitting behind it and the
-- function stays callable with no session at all. Supabase's linter catches it;
-- this is the fix it asks for.
revoke execute on function public.my_plan() from public;
revoke execute on function public.my_plan() from anon;
grant execute on function public.my_plan() to authenticated;

-- The opt in: take the free month, once.
--
-- SECURITY DEFINER, and this one means it. entitlements has no insert policy
-- for anybody, which is the entire point of the table, so the only way a row
-- gets written for an ordinary account is through a function holding the
-- definer's privileges. The linter reports that authenticated can call a
-- SECURITY DEFINER function, and that is what it is for.
--
-- It takes no argument, for the same reason my_plan() does not: a
-- start_trial(uid) would let any signed-in account start a trial on any other.
-- Nothing about the length or the end date comes from the caller either - a
-- browser that could name its own expiry would name one a long way off.
--
-- It returns a refusal as a value rather than raising. These come back to a
-- person as a sentence, and "this account has already had its free month" is
-- an answer rather than an error.
create or replace function public.start_trial()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me    uuid := (select auth.uid());
  -- Thirty days. Said again in assets/js/lib/tiers.js, which is what the
  -- interface counts down with, and in the account tool's actions.mjs, which
  -- is what an administrator handing one out writes. test/tiers.test.mjs reads
  -- all three and fails if they disagree; this is the one that decides.
  ends  timestamptz := now() + interval '30 days';
begin
  if me is null then
    return jsonb_build_object('ok', false, 'error', 'Sign in first.');
  end if;

  if exists (select 1 from public.trials where user_id = me) then
    return jsonb_build_object('ok', false,
      'error', 'This account has already had its free month.');
  end if;

  -- Any entitlement at all, expired or not. Somebody holding Premium has
  -- nothing to start, and somebody whose subscription has lapsed is not a new
  -- account. An administrator can still hand out a trial from the account
  -- tool, which is the deliberate exception rather than this path.
  if exists (select 1 from public.entitlements where user_id = me) then
    return jsonb_build_object('ok', false,
      'error', 'This account already has a plan, so there is no trial to start.');
  end if;

  insert into public.trials (user_id, started_at, ends_at) values (me, now(), ends);

  insert into public.entitlements (user_id, tier, source, expires_at, renews, note, updated_at)
  values (me, 'premium', 'trial', ends, false, 'Free trial, started from the app.', now());

  return jsonb_build_object('ok', true, 'plan', public.my_plan());
end;
$$;

revoke execute on function public.start_trial() from public;
revoke execute on function public.start_trial() from anon;
grant execute on function public.start_trial() to authenticated;

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
  using (lower((select auth.jwt()) ->> 'email') = 'shermancahal@gmail.com')
  with check (lower((select auth.jwt()) ->> 'email') = 'shermancahal@gmail.com');

-- ------------------------------------------------------------ folder links
--
-- A copy of a folder anybody holding the link can open, for thirty days.
--
-- Sending a folder used to mean sending a GPX, and a phone opens a GPX only
-- with an app that reads one: the person it went to tapped it and got nothing.
-- A link opens in any browser. What it opens is a snapshot - the places as
-- they were when it was made, not the folder itself - so it carries none of
-- the sender's account, and changing or deleting the folder later changes
-- nothing for whoever has the link. Inviting somebody to the folder itself is
-- the Premium feature in "sharing" above; this is the copy.
--
-- Nobody writes to the table directly. create_folder_link() is the way in, so
-- the limits below are the server's rather than a browser's: signed in, a
-- FeatureCollection, at most 2,000 places and 2 MB, fifty links a day. The id
-- is 32 hex characters of a random UUID, which is what makes it unguessable;
-- open_folder_link() hands back one by its id and never lists them.

create table if not exists public.folder_links (
  id          text        primary key check (id ~ '^[0-9a-f]{32}$'),
  owner       uuid        not null references auth.users (id) on delete cascade,
  name        text        not null check (char_length(name) between 1 and 120),
  features    integer     not null check (features between 1 and 2000),
  geojson     jsonb       not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);

create index if not exists folder_links_owner_created
  on public.folder_links (owner, created_at desc);

alter table public.folder_links enable row level security;

-- Your own links, to see and to take back. No insert or update policy: the
-- function below is the only way in.
drop policy if exists "your own folder links" on public.folder_links;
create policy "your own folder links"
  on public.folder_links
  for select
  to authenticated
  using (owner = (select auth.uid()));

drop policy if exists "take back your own folder links" on public.folder_links;
create policy "take back your own folder links"
  on public.folder_links
  for delete
  to authenticated
  using (owner = (select auth.uid()));

create or replace function public.create_folder_link(link_name text, collection jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me     uuid := (select auth.uid());
  places integer;
  today  integer;
  made   public.folder_links;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'error', 'Sign in to send a link.');
  end if;

  if jsonb_typeof(collection) is distinct from 'object'
     or collection ->> 'type' is distinct from 'FeatureCollection'
     or jsonb_typeof(collection -> 'features') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'error', 'That is not a folder of places.');
  end if;

  places := jsonb_array_length(collection -> 'features');
  if places = 0 then
    return jsonb_build_object('ok', false, 'error', 'That folder is empty, so there is nothing to send.');
  end if;
  if places > 2000 then
    return jsonb_build_object('ok', false, 'error',
      format('A link carries up to 2,000 places, and this folder has %s. Send it as a file instead.', places));
  end if;
  if pg_column_size(collection) > 2000000 then
    return jsonb_build_object('ok', false, 'error',
      'That folder is too large for a link - long tracks, most likely. Send it as a file instead.');
  end if;

  select count(*) into today
    from public.folder_links
   where owner = me and created_at > now() - interval '1 day';
  if today >= 50 then
    return jsonb_build_object('ok', false, 'error',
      'That is fifty links today, which is the limit. The ones already sent still work.');
  end if;

  insert into public.folder_links (id, owner, name, features, geojson)
  values (
    replace(gen_random_uuid()::text, '-', ''),
    me,
    left(coalesce(nullif(btrim(link_name), ''), 'Shared places'), 120),
    places,
    collection
  )
  returning * into made;

  return jsonb_build_object('ok', true, 'id', made.id, 'expires_at', made.expires_at, 'features', places);
end;
$$;

revoke execute on function public.create_folder_link(text, jsonb) from public;
revoke execute on function public.create_folder_link(text, jsonb) from anon;
grant execute on function public.create_folder_link(text, jsonb) to authenticated;

-- Anybody with the link, signed in or not: the person it was sent to may not
-- have an account, and needs none to look.
create or replace function public.open_folder_link(link_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
              'ok', true, 'name', l.name, 'features', l.features,
              'geojson', l.geojson, 'created_at', l.created_at, 'expires_at', l.expires_at)
       from public.folder_links l
      where l.id = link_id
        and link_id ~ '^[0-9a-f]{32}$'
        and l.expires_at > now()),
    jsonb_build_object('ok', false,
      'error', 'That link has expired or was taken back. Ask whoever sent it for a new one.'));
$$;

revoke execute on function public.open_folder_link(text) from public;
grant execute on function public.open_folder_link(text) to anon, authenticated;

-- Expired links are never read again - open_folder_link() checks expires_at -
-- but they stay in the table until cleared. Nothing clears them on its own:
-- there is no scheduler on this project. Run this now and then from the SQL
-- editor; it removes only links more than a day past their end.
--
--   delete from public.folder_links where expires_at < now() - interval '1 day';
