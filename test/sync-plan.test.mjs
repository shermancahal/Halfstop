/**
 * Folder sync is Premium, and the database is what says so.
 *
 * tiers.js has always claimed folder sync was "enforced by the row-level
 * policy on the Supabase table". For as long as that policy was ownership
 * only, it was not: the app's gate was the whole rule, and a gate in the
 * browser is one devtools edit away from open. The policies now ask for the
 * plan, and these tests read schema.sql for the shape of that rule - the
 * part that is easy to undo in good faith, by merging four policies back into
 * one FOR ALL, or by moving a check from WITH CHECK into USING where a refusal
 * turns into a silent zero rows.
 *
 * What the database actually does with them was checked on the live project,
 * as each account, inside a rolled-back transaction; supabase/rls-probe.sql
 * has the same cases for running again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { Account, refusalFor } from '../assets/js/lib/account.js';

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

test('sync plan: an owner writes a folder only with Premium, and the check is on the new row', () => {
  const policies = folderPolicies(schema);
  for (const command of ['insert', 'update']) {
    const own = policies.filter((policy) => policy.command === command && /auth\.uid\(\)\)\s*=\s*user_id/.test(policy.using + policy.check)
      && !/folder_shares/.test(policy.using + policy.check));
    assert.equal(own.length, 1, `expected one owner ${command} policy`);
    assert.match(own[0].check, /private\.holds_premium\(\(select auth\.uid\(\)\)\)/,
      `the owner ${command} policy does not ask for the plan in WITH CHECK`);
    // In USING the refusal would be zero rows updated, which supabase-js
    // reports as success and the app would take for a save.
    assert.doesNotMatch(own[0].using, /holds_premium/, `the owner ${command} policy asks for the plan in USING`);
  }
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

test('sync plan: a refusal from the policy is said in words, anything else as it came', () => {
  const policy = { code: '42501', message: 'new row violates row-level security policy for table "folders"' };
  assert.match(refusalFor(policy), /Premium/);
  assert.doesNotMatch(refusalFor(policy), /row-level/);
  assert.match(refusalFor(policy, { shared: true }), /owner of this folder/);
  // Recognised by the words too, for a client that drops the code.
  assert.match(refusalFor({ message: 'new row violates row-level security policy' }), /Premium/);
  // Not every failure is the plan, and must not be explained as one.
  assert.equal(refusalFor({ code: '23505', message: 'duplicate key' }), 'duplicate key');
  assert.equal(refusalFor(null), '');
});

function refusingClient() {
  const refused = { code: '42501', message: 'new row violates row-level security policy for table "folders"' };
  return {
    from() {
      return {
        async upsert() { return { error: refused }; },
        update() { return { eq() { return { async eq() { return { error: refused }; } }; } }; },
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
  assert.match(account.message, /^Not saved to your account: syncing is part of Premium/);

  await account.pushFolder({ id: 'theirs', name: 'Theirs', items: [], sharedFrom: { ownerId: 'them', role: 'editor' } });
  assert.match(account.message, /^Not saved to your account: the owner of this folder no longer has Premium/);
});
