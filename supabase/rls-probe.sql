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
-- the email in the session rather than on the user id. The first must hold
-- Premium: an edit to a shared folder is refused while its owner does not,
-- and "invited to edit" would then stop with 42501 - see the last block.
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
-- And the same question about entitlements and trials.
--
-- Run this separately from the block above: the write attempt is refused by
-- the policy, and a refusal aborts the transaction it is in, which is the
-- correct behaviour and also means nothing after it would run.
--
-- Expected:
--
--   the administrator   tier premium, source granted, until null,
--                       trialAvailable false
--   an account on its   tier premium, source trial, until the end of the
--     free month         month, trialAvailable false
--   any other account   tier free, source none. trialAvailable is true only
--                       if it has never started a trial and holds no
--                       entitlement row at all
--   rows it can see     1 for itself, and never anybody else's
--
-- A new account reads FREE here, which is the change worth noticing. The trial
-- used to be worked out from the signup date, so every account less than a
-- month old reported premium whether or not anybody had asked for one. It is a
-- row now, written by public.start_trial(), and an account that has not taken
-- one has not got one.
--
-- Then, on their own, the write attempts below: each must fail with
-- 42501 "new row violates row-level security policy". A success there means
-- any signed-in account can hand itself premium - or a free month that never
-- ends - and the tables are decoration.

begin;
create temp table plans (case_name text, result text) on commit drop;
grant all on plans to authenticated;

set local role authenticated;

set local request.jwt.claims = '{"sub":"OWNER-USER-ID","email":"owner@example.com","role":"authenticated"}';
insert into plans select 'administrator', public.my_plan()::text;
insert into plans select 'rows it can see', (select count(*)::text from public.entitlements);
insert into plans select 'trials it can see', (select count(*)::text from public.trials);

set local request.jwt.claims = '{"sub":"INVITED-USER-ID","email":"invited@example.com","role":"authenticated"}';
insert into plans select 'other account', public.my_plan()::text;
insert into plans select 'rows it can see', (select count(*)::text from public.entitlements);
insert into plans select 'trials it can see', (select count(*)::text from public.trials);

reset role;
select * from plans;
rollback;

-- The write attempts, one at a time, because each aborts what it is in.
--
-- begin;
-- set local role authenticated;
-- set local request.jwt.claims = '{"sub":"INVITED-USER-ID","email":"invited@example.com","role":"authenticated"}';
-- insert into public.entitlements (user_id, tier, source)
-- values ('INVITED-USER-ID', 'premium', 'granted');
-- rollback;
--
-- And the same for the trial, which is the other way to help yourself to
-- Premium: a row this account could write is a row it could date ten years
-- out. public.start_trial() is the only way in, and it picks the dates.
--
-- begin;
-- set local role authenticated;
-- set local request.jwt.claims = '{"sub":"INVITED-USER-ID","email":"invited@example.com","role":"authenticated"}';
-- insert into public.trials (user_id, ends_at)
-- values ('INVITED-USER-ID', now() + interval '3650 days');
-- rollback;

-- ---------------------------------------------------------------------------
-- And whether syncing asks for the plan.
--
-- Two real accounts: PAID holds Premium, FREE holds nothing. Run as one
-- statement. It ends by raising an exception on purpose - that is what rolls
-- all of it back, including the moment in the middle where PAID's
-- entitlement is deleted to see what a lapsed owner can still do - and the
-- report is the exception's message.
--
-- Expected, as it came back on the live project on 2026-09-27:
--
--   A free insert own             refused 42501
--   B free update own             refused 42501   an error, not 0 rows
--   C free read own               1 row
--   D paid insert own             1 row
--   E paid update own             1 row
--   F free editor, paid owner     1 row           the collaborator needs no plan
--   G free editor, lapsed owner   refused 42501   the owner does
--   H lapsed update own           refused 42501
--   I lapsed read own             every row       nothing is taken away
--   J invitee read, lapsed owner  1 row
--   K lapsed delete own           1 row
--   L free delete own             1 row
--
-- do $probe$
-- declare
--   paid uuid := (select id from auth.users where email = 'PAID@example.com');
--   free uuid := (select id from auth.users where email = 'FREE@example.com');
--   paid_claims text := json_build_object('sub', paid, 'email', 'PAID@example.com', 'role', 'authenticated')::text;
--   free_claims text := json_build_object('sub', free, 'email', 'FREE@example.com', 'role', 'authenticated')::text;
--   report text := E'\n';
--   n int;
-- begin
--   perform set_config('request.jwt.claims', free_claims, true);
--   insert into public.folders (user_id, client_id, name) values (free, 'rls-probe-free', 'Probe');
--   perform set_config('request.jwt.claims', paid_claims, true);
--   insert into public.folders (user_id, client_id, name) values (paid, 'rls-probe-paid', 'Probe');
--   insert into public.folder_shares (owner_id, client_id, invited_email, role)
--     values (paid, 'rls-probe-paid', 'FREE@example.com', 'editor');
--
--   -- One of these per case; the rest follow the same shape with the
--   -- statement from the table above. A refusal is caught, which undoes only
--   -- that case, and the SET LOCAL ROLE goes with it.
--   begin
--     perform set_config('request.jwt.claims', free_claims, true);
--     set local role authenticated;
--     insert into public.folders (user_id, client_id, name) values (free, 'rls-probe-free-2', 'x');
--     get diagnostics n = row_count; reset role;
--     report := report || 'A free insert own: ' || n || E' row\n';
--   exception when others then report := report || 'A free insert own: refused ' || sqlstate || E'\n'; end;
--
--   -- ... B to F, then:
--   delete from public.entitlements where user_id = paid;
--   -- ... G to L.
--
--   raise exception 'PROBE RESULT (rolled back):%', report;
-- end
-- $probe$;
