-- What the row-level policies actually do, asked of the database itself.
--
-- Run it in the SQL editor. It writes nothing: everything happens inside a
-- transaction that ends in ROLLBACK, including the folder and the invitation
-- it invents to have something to push against.
--
-- WHY THIS FILE EXISTS
--
-- The unit tests cover the merge, which decides what the app sends. They
-- cannot cover what the database accepts, and that is the part that is load
-- bearing: the app hiding a button is presentation, and the policy is the
-- boundary. Co-editing turned an owner-only table into one two accounts can
-- write to, which is exactly when "I reasoned about it" stops being good
-- enough.
--
-- Set the two accounts below to real ones on this project before running. The
-- second must be an address that has signed in, because the policy matches on
-- the email in the session rather than on the user id.
--
-- Expected, and the whole point of running it:
--
--   invited to view        0 rows   looking at a folder is not editing it
--   invited to edit        1 row    and the owner, the filing and the
--                                   deleted flag all come back unchanged,
--                                   though the update tried to set all three
--   editor tries to delete 0 rows   deletion stays with the owner

begin;

create temp table probe (case_name text, rows_written int, owner text, parent text, gone bool) on commit drop;
grant all on probe to authenticated;

-- The owner, and something of theirs to aim at. Claims are set first because
-- folders_set_owner stamps the row from auth.uid(), which is empty without one.
set local request.jwt.claims = '{"sub":"OWNER-USER-ID","email":"owner@example.com","role":"authenticated"}';
insert into public.folders (user_id, client_id, name, parent_id, items)
values ('OWNER-USER-ID', 'rls-probe', 'Probe', 'shelf', '[]'::jsonb);
insert into public.folder_shares (owner_id, client_id, invited_email, role)
values ('OWNER-USER-ID', 'rls-probe', 'invited@example.com', 'viewer');

-- From here on, act as the invited account the way PostgREST does.
set local role authenticated;
set local request.jwt.claims = '{"sub":"INVITED-USER-ID","email":"invited@example.com","role":"authenticated"}';

with attempt as (
  update public.folders set name = 'Taken' where client_id = 'rls-probe'
  returning user_id::text as owner, parent_id, deleted
)
insert into probe select 'invited to view', count(*), max(owner), max(parent_id), bool_or(deleted) from attempt;

-- Upgrade the invitation, as the owner.
reset role;
set local request.jwt.claims = '{"sub":"OWNER-USER-ID","email":"owner@example.com","role":"authenticated"}';
update public.folder_shares set role = 'editor' where client_id = 'rls-probe';

-- The most hostile write a collaborator could send: take the folder, refile it,
-- and delete it. Every one of those three is the owner's to make.
set local role authenticated;
set local request.jwt.claims = '{"sub":"INVITED-USER-ID","email":"invited@example.com","role":"authenticated"}';

with attempt as (
  update public.folders
  set name = 'Worked on together',
      user_id = 'INVITED-USER-ID',
      parent_id = 'hijacked',
      deleted = true
  where client_id = 'rls-probe'
  returning user_id::text as owner, parent_id, deleted
)
insert into probe select 'invited to edit', count(*), max(owner), max(parent_id), bool_or(deleted) from attempt;

with attempt as (
  delete from public.folders where client_id = 'rls-probe' returning user_id::text as owner
)
insert into probe select 'editor tries to delete', count(*), max(owner), null, null from attempt;

reset role;
select * from probe;

rollback;

-- ---------------------------------------------------------------------------
-- And the same question about entitlements.
--
-- Run this separately from the block above: the write attempt is refused by
-- the policy, and a refusal aborts the transaction it is in, which is the
-- correct behaviour and also means nothing after it would run.
--
-- Expected:
--
--   the administrator   tier premium, source granted, until null
--   a new account       tier premium, source trial,   until 30 days on
--   an old account      tier free
--   rows it can see     1 for itself, and never anybody else's
--
-- Then, on its own, the write attempt below: it must fail with
-- 42501 "new row violates row-level security policy". A success there means
-- any signed-in account can hand itself premium, and the table is decoration.

begin;
create temp table plans (case_name text, result text) on commit drop;
grant all on plans to authenticated;

set local role authenticated;

set local request.jwt.claims = '{"sub":"OWNER-USER-ID","email":"owner@example.com","role":"authenticated"}';
insert into plans select 'administrator', public.my_plan()::text;
insert into plans select 'rows it can see', (select count(*)::text from public.entitlements);

set local request.jwt.claims = '{"sub":"INVITED-USER-ID","email":"invited@example.com","role":"authenticated"}';
insert into plans select 'other account', public.my_plan()::text;
insert into plans select 'rows it can see', (select count(*)::text from public.entitlements);

reset role;
select * from plans;
rollback;

-- The write attempt, alone, because it aborts what it is in.
--
-- begin;
-- set local role authenticated;
-- set local request.jwt.claims = '{"sub":"INVITED-USER-ID","email":"invited@example.com","role":"authenticated"}';
-- insert into public.entitlements (user_id, tier, source)
-- values ('INVITED-USER-ID', 'premium', 'granted');
-- rollback;
