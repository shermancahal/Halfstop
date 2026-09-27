/**
 * How much syncs on which plan, and that the database is what says so.
 *
 * A free account syncs up to FREE_SYNC; Premium syncs any amount; sharing is
 * Premium, and it is the owner's plan that counts. For as long as the folders
 * policy was ownership only, none of that was true: the app's gate was the
 * whole rule, and a gate in the browser is one devtools edit away from open.
 * A trigger now counts, and these tests read schema.sql for the shape of the
 * rule - the parts easy to undo in good faith: the two copies of the numbers
 * drifting apart, a trigger that fires before the owner is stamped, a check
 * that refuses shrinking and so traps an account over the allowance.
 *
 * What the database actually does with them was checked on the live project,
 * as each account, inside a rolled-back transaction; supabase/rls-probe.sql
 * has the same cases for running again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { Account, refusalFor } from '../assets/js/lib/account.js';
import { FREE_SYNC, syncLoad, allowanceNote, TIERS } from '../assets/js/lib/tiers.js';

const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const invite = await readFile(new URL('../supabase/functions/invite-to-folder/index.ts', import.meta.url), 'utf8');

/** Every policy created on public.folders, as { name, command, using, check }. */
function folderPolicies(sql) {
  const policies = [];
  const pattern = /create policy "([^"]+)"\s+on public\.folders\s+for (\w+)\s+to \w+([\s\S]*?);/g;
  for (const [, name, command, body] of sql.matchAll(pattern)) {
    const checkAt = body.indexOf('with check');
    policies.push({
      name,
      command: command.toLowerCase(),
      using: checkAt === -1 ? body : body.slice(0, checkAt),
      check: checkAt === -1 ? '' : body.slice(checkAt),
    });
  }
  return policies;
}

const squash = (text) => text.replace(/\be\./g, '').replace(/\s+/g, '');

test('sync plan: no policy on folders covers every command at once', () => {
  /*
   * The old FOR ALL policy is the easiest way back to the hole: it answers
   * select, insert, update and delete with one expression, so the plan is
   * either asked of reading and deleting too - taking somebody's own folders
   * away from them the day a card fails - or of nothing.
   */
  const policies = folderPolicies(schema);
  assert.ok(policies.length >= 5, `found only ${policies.length} policies on folders`);
  assert.deepEqual(policies.filter((policy) => policy.command === 'all').map((policy) => policy.name), []);
  assert.doesNotMatch(schema, /create policy "folders are private to their owner"/);
});

test('sync plan: an owner\u2019s own policies are about ownership, and the plan is counted by a trigger', () => {
  const policies = folderPolicies(schema);
  for (const command of ['insert', 'update']) {
    const own = policies.filter((policy) => policy.command === command && !/folder_shares/.test(policy.using + policy.check));
    assert.equal(own.length, 1, `expected one owner ${command} policy`);
    assert.match(own[0].check, /\(select auth\.uid\(\)\) = user_id/);
    // A plan in the policy is all or nothing, which is what shut free
    // accounts out of syncing altogether for a day. How much is a count, and
    // counting is the trigger's.
    assert.doesNotMatch(own[0].using + own[0].check, /holds_premium/, `the owner ${command} policy asks for a plan`);
  }
  assert.match(schema, /create trigger folders_within_allowance_trigger\s+before insert or update on public\.folders\s+for each row execute function private\.folders_within_allowance\(\);/);
});

/** The body of private.folders_within_allowance, from schema.sql. */
function allowanceFunction() {
  const start = schema.indexOf('create or replace function private.folders_within_allowance()');
  assert.ok(start > -1, 'the allowance trigger function is not defined');
  return schema.slice(start, schema.indexOf('$$;', start));
}

test('sync plan: the database and the app hold the same free allowance', () => {
  /*
   * Two copies of two numbers, on purpose: the trigger is the rule and
   * FREE_SYNC is what the app says and checks before sending. If they drift,
   * the app either promises room the server refuses, or holds folders back
   * that would have been accepted.
   */
  const body = allowanceFunction();
  const folders = Number(body.match(/folder_limit constant integer := (\d+);/)?.[1]);
  const items = Number(body.match(/item_limit constant integer := (\d+);/)?.[1]);
  assert.equal(folders, FREE_SYNC.folders, 'the folder allowance differs between schema.sql and tiers.js');
  assert.equal(items, FREE_SYNC.waypoints, 'the waypoint allowance differs between schema.sql and tiers.js');
});

test('sync plan: the trigger asks the owner\u2019s plan, counts the owner\u2019s rows, and refuses only growth', () => {
  const body = allowanceFunction();
  // The folder's owner, not whoever is writing: a collaborator's edit to a
  // shared folder lands in the owner's collection.
  assert.match(body, /private\.holds_premium\(new\.user_id\)/);
  assert.match(body, /where f\.user_id = new\.user_id/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
  // Tombstones are not things anybody is keeping.
  assert.match(body, /and not f\.deleted/);
  // Growth only: an account over the allowance must always be able to trim.
  assert.match(body, /now_folders > folder_limit and now_folders > was_folders/);
  assert.match(body, /now_items > item_limit and now_items > was_items/);
  // Its own SQLSTATE, which refusalFor recognises.
  assert.match(body, /errcode = 'HSLIM'/);
  // Triggers on one event fire in name order, and this one must count the
  // owner that folders_set_owner_trigger has already stamped.
  assert.ok('folders_within_allowance_trigger' > 'folders_set_owner_trigger');
  assert.match(schema, /create trigger folders_set_owner_trigger/);
});

test('sync plan: the app counts a collection the way the trigger does', () => {
  const folder = (items, extra = {}) => ({ id: String(Math.random()), items: Array.from({ length: items }, (_, i) => ({ id: i })), ...extra });
  const load = syncLoad([
    folder(40), folder(60),
    folder(500, { deleted: true }),
    folder(300, { sharedFrom: { ownerId: 'someone', role: 'editor' } }),
  ]);
  assert.deepEqual(load, { folders: 2, waypoints: 100 });
  assert.equal(allowanceNote(load), '', 'exactly the allowance fits');
  assert.match(allowanceNote({ folders: 2, waypoints: 101 }), /up to 100 folders and 100 waypoints.*101 waypoints in 2 folders/);
  assert.match(allowanceNote({ folders: 101, waypoints: 0 }), /0 waypoints in 101 folders/);
  // Premium's grants include folderSync, which is what means "no allowance".
  assert.ok(TIERS.premium.grants.includes('folderSync'));
  assert.ok(!TIERS.free.grants.includes('folderSync'));
});

test('sync plan: reading and removing your own folders never asks for a plan', () => {
  /*
   * The FAQ promises that nothing is deleted when a subscription ends and that
   * getting your own data out is free. A folder the server keeps but will not
   * show its owner would break both promises at once.
   */
  const policies = folderPolicies(schema);
  for (const command of ['select', 'delete']) {
    const own = policies.filter((policy) => policy.command === command && !/folder_shares/.test(policy.using));
    assert.equal(own.length, 1, `expected one owner ${command} policy`);
    assert.match(own[0].using, /\(select auth\.uid\(\)\) = user_id/);
    assert.doesNotMatch(own[0].using + own[0].check, /holds_premium/, `reading or removing asks for a plan (${command})`);
  }
});

test('sync plan: a collaborator edits only while the owner holds Premium', () => {
  /*
   * The owner's plan, not the collaborator's. Asking the collaborator would
   * put sharing behind Premium for the person invited, which it is not; asking
   * nobody left a way round the rule - a free month, a folder shared with a
   * second free account to edit, and that folder syncing there for ever.
   */
  const coEdit = folderPolicies(schema).find((policy) => policy.command === 'update' && /folder_shares/.test(policy.using));
  assert.ok(coEdit, 'no co-editing policy found');
  assert.match(coEdit.check, /private\.holds_premium\(folders\.user_id\)/);
  assert.doesNotMatch(coEdit.check, /holds_premium\(\(select auth\.uid\(\)\)\)/,
    'the co-editing policy asks for the collaborator’s plan rather than the owner’s');
});

test('sync plan: holds_premium is the same premium my_plan() reports, and not served over the API', () => {
  const start = schema.indexOf('create or replace function private.holds_premium');
  assert.ok(start > -1, 'private.holds_premium is not defined');
  const definition = schema.slice(start, schema.indexOf('$$;', start));
  const plan = schema.slice(schema.indexOf('create or replace function public.my_plan'));
  const planHeld = plan.slice(0, plan.indexOf('offered as'));

  // One definition of "holds Premium", said twice: if my_plan() and the
  // policy disagree, somebody is shown a plan the server will not honour.
  for (const clause of ["tier='premium'", '(expires_atisnullorexpires_at>now())']) {
    assert.ok(squash(definition).includes(clause), `holds_premium lacks ${clause}`);
    assert.ok(squash(planHeld).includes(clause), `my_plan lacks ${clause}`);
  }

  // It has to look at another account's row for the co-editing check, which
  // is what security definer is for - and why it must not sit in public,
  // where PostgREST would answer anybody asking whether any account pays.
  assert.match(definition, /security definer/);
  assert.match(definition, /set search_path = ''/);
  assert.doesNotMatch(schema, /function public\.holds_premium/);
  assert.match(schema, /revoke execute on function private\.holds_premium\(uuid\) from public;/);
  assert.match(schema, /revoke all on schema private from public;/);
});

test('sync plan: schema.sql still runs top to bottom on an empty database', () => {
  /*
   * A sql-language function's body is checked when it is created, so one that
   * reads public.entitlements above the table's own create statement stops
   * the file at that line on a fresh project. plpgsql looks the table up when
   * it runs.
   */
  const start = schema.indexOf('create or replace function private.holds_premium');
  const definition = schema.slice(start, schema.indexOf('$$;', start));
  const table = schema.indexOf('create table if not exists public.entitlements');
  assert.ok(/language plpgsql/.test(definition) || start > table,
    'holds_premium is a sql function defined before the table it reads');
});

test('sync plan: an invitation asks for the owner’s plan before it records or sends anything', () => {
  const asked = invite.indexOf("asCaller.rpc('my_plan')");
  assert.ok(asked > -1, 'invite-to-folder does not check the plan');
  assert.ok(asked < invite.indexOf(".from('folder_shares')"), 'the plan is checked after the invitation is recorded');
  assert.ok(asked < invite.indexOf('await sendInvitation('), 'the plan is checked after the email is sent');
  // Asked of the caller's own session, not the service key, which has no plan.
  assert.doesNotMatch(invite, /admin\.rpc\('my_plan'\)/);
  assert.match(invite, /plan\?\.tier !== 'premium'/);
});

test('sync plan: a refusal about the plan is said in words, anything else as it came', () => {
  const limit = { code: 'HSLIM', message: 'A free account syncs up to 100 folders and 100 waypoints.' };
  assert.match(refusalFor(limit), /free account syncs up to 100 folders and 100 waypoints/);
  assert.match(refusalFor(limit), /stays on this device/);

  const policy = { code: '42501', message: 'new row violates row-level security policy for table "folders"' };
  assert.match(refusalFor(policy, { shared: true }), /owner of this folder no longer has Premium/);
  // Recognised by the words too, for a client that drops the code.
  assert.match(refusalFor({ message: 'new row violates row-level security policy' }, { shared: true }), /owner/);
  // On your own folder a policy refusal is not about any plan any more, and
  // must not be explained as one.
  assert.equal(refusalFor(policy), policy.message);
  assert.equal(refusalFor({ code: '23505', message: 'duplicate key' }), 'duplicate key');
  assert.equal(refusalFor(null), '');
});

function refusingClient() {
  const overAllowance = { code: 'HSLIM', message: 'A free account syncs up to 100 folders and 100 waypoints.' };
  const ownerLapsed = { code: '42501', message: 'new row violates row-level security policy for table "folders"' };
  return {
    from() {
      return {
        async upsert() { return { error: overAllowance }; },
        update() { return { eq() { return { async eq() { return { error: ownerLapsed }; } }; } }; },
      };
    },
  };
}

test('sync plan: an edit the server refuses says why, for your folder and for one shared with you', async () => {
  const client = refusingClient();
  const folders = { list: () => [], snapshot: () => [], replaceAll() {} };
  const account = new Account(folders, { client: async () => client, configured: () => true });
  account.user = { id: 'me' };

  await account.pushFolder({ id: 'mine', name: 'Mine', items: [] });
  assert.match(account.message, /^Not saved to your account: a free account syncs up to 100 folders and 100 waypoints/);

  await account.pushFolder({ id: 'theirs', name: 'Theirs', items: [], sharedFrom: { ownerId: 'them', role: 'editor' } });
  assert.match(account.message, /^Not saved to your account: the owner of this folder no longer has Premium/);
});
