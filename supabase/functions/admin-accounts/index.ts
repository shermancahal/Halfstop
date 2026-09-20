/**
 * Managing accounts, for the one address allowed to.
 *
 * WHY THIS EXISTS AS A FUNCTION
 *
 * The support queue works from the browser because row-level security can
 * express "the signed-in email is the administrator" in SQL. None of this can:
 * listing accounts, inviting one, and deleting an auth record all need the
 * service key, and a service key in a page is a service key in everybody's
 * devtools. So the page asks, and this decides.
 *
 * WHO IS ALLOWED
 *
 * The address on the verified JWT, checked against ADMIN_EMAILS on this
 * function. Not SITE.editors, which is client configuration anybody can edit,
 * and not anything in the request body. An unset ADMIN_EMAILS is nobody rather
 * than everybody - see actions.mjs, where that choice is tested.
 *
 * WHAT IT WILL NOT DO
 *
 * Touch an entitlement that came from Stripe or the App Store. Those rows
 * mirror a subscription this tool cannot cancel; revoking one would take
 * access away from somebody who is still paying, and granting over one would
 * be overwritten by the next webhook. It says so rather than doing it.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { mayAdminister, readRequest, mayChange, whyNot, describeAccount, planRow } from './actions.mjs';

/** The table the app keeps folders in. Rows are filed under `user_id`. */
const TABLE = 'folders';

/*
 * Both key generations, because a project can be on either. The legacy
 * service_role key is a plain string; the newer secret keys arrive as a JSON
 * object keyed by name. Reading whichever exists means this keeps working
 * across that migration rather than failing the day the old one is turned off.
 */
function keyFrom(jsonName: string, legacyName: string): string {
  const bundle = Deno.env.get(jsonName);
  if (bundle) {
    try {
      const keys = JSON.parse(bundle);
      const value = keys.default || Object.values(keys)[0];
      if (typeof value === 'string' && value) return value;
    } catch {
      // Fall through to the legacy name rather than failing on a shape change.
    }
  }
  return Deno.env.get(legacyName) || '';
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const url = Deno.env.get('SUPABASE_URL') || '';
  const publishable = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const secret = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publishable || !secret) {
    return reply(500, { error: 'This function is missing its Supabase environment.' });
  }

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization) return reply(401, { error: 'Sign in first.' });

  // Who is asking, according to the token rather than according to them.
  const asCaller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoError } = await asCaller.auth.getUser();
  const caller = who?.user;
  if (whoError || !caller) return reply(401, { error: 'That session is not valid.' });

  /*
   * 404 rather than 403, deliberately.
   *
   * A 403 tells somebody probing that the endpoint is real and that they have
   * found the right door. There is nothing to gain from confirming it.
   */
  if (!mayAdminister(caller.email, Deno.env.get('ADMIN_EMAILS'))) {
    console.warn(`[admin-accounts] refused ${caller.email}`);
    return reply(404, { error: 'Not found.' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'That was not JSON.' });
  }

  const read = readRequest(body, { caller: caller.email });
  if (!read.ok) return reply(read.status, { error: read.error });

  const admin = createClient(url, secret, { auth: { persistSession: false } });

  if (read.action === 'list') {
    const { data: listed, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) return reply(500, { error: `Could not read the accounts: ${error.message}` });

    const users = listed?.users || [];
    const { data: rights } = await admin.from('entitlements').select('*');
    const { data: folders } = await admin.from(TABLE).select('user_id').eq('deleted', false);
    // Who has spent their free month. Read separately from the entitlement
    // because it outlives one: the row stays after a trial ends, after it is
    // replaced by a purchase, and after somebody is set back to Free.
    const { data: trials } = await admin.from('trials').select('user_id');

    const byUser = new Map((rights || []).map((row: Record<string, unknown>) => [row.user_id, row]));
    const tried = new Set((trials || []).map((row: Record<string, unknown>) => row.user_id as string));
    const counted = new Map<string, number>();
    for (const row of folders || []) {
      counted.set(row.user_id as string, (counted.get(row.user_id as string) || 0) + 1);
    }

    return reply(200, {
      ok: true,
      accounts: users.map((user) => describeAccount(
        user,
        byUser.get(user.id),
        counted.get(user.id) || 0,
        { trialUsed: tried.has(user.id) },
      )),
    });
  }

  if (read.action === 'invite') {
    /*
     * Invited rather than created with a password.
     *
     * The person sets their own, the address is confirmed by the act of
     * accepting, and nobody else ever knows their password - which is not true
     * of an account made on their behalf and read out over a phone.
     */
    const { data, error } = await admin.auth.admin.inviteUserByEmail(read.email, {
      redirectTo: (Deno.env.get('SITE_URL') || 'https://app.halfstop.app/').replace(/\/?$/, '/') + 'account.html',
    });
    if (error) return reply(400, { error: `Could not invite them: ${error.message}` });
    console.log(`[admin-accounts] invited ${read.email}`);
    return reply(200, { ok: true, invited: data?.user?.id || null });
  }

  // Everything below is about one existing account, so read what it has first.
  const { data: held } = await admin.from('entitlements')
    .select('source, tier')
    .eq('user_id', read.userId)
    .maybeSingle();

  if (read.action === 'setPlan') {
    if (held && !mayChange(held.source)) return reply(409, { error: whyNot(held.source) });

    const row = planRow(read.plan, { until: read.until, by: caller.email });

    if (!row) {
      /*
       * Free: the row is deleted rather than given a date in the past.
       *
       * A row that has expired and a row that is not there mean the same
       * thing to my_plan(), and the absent one cannot be misread later as
       * "this account once paid".
       *
       * The trials row is deliberately left alone. It is the record that this
       * account has had its free month, and clearing it here would mean
       * setting somebody back to Free silently handed them another one -
       * which is the exact loop the separate table exists to close. An
       * administrator who does mean to give a second trial presses Trial,
       * which says so.
       */
      const { error } = await admin.from('entitlements').delete().eq('user_id', read.userId);
      if (error) return reply(500, { error: `Could not set them to Free: ${error.message}` });
      console.log(`[admin-accounts] ${caller.email} set ${read.userId} to free`);
      return reply(200, { ok: true, plan: 'free' });
    }

    const { error } = await admin.from('entitlements').upsert({
      user_id: read.userId,
      ...row,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) return reply(500, { error: `Could not set that plan: ${error.message}` });

    /*
     * A trial set from here is recorded as one, so it cannot be started again
     * from the app afterwards. Upserted rather than inserted because an
     * administrator handing out a second trial is a thing they are allowed to
     * do - deliberately, by pressing the button - and it must not fail on the
     * primary key of the row saying they had the first.
     */
    if (read.plan === 'trial') {
      const { error: markError } = await admin.from('trials').upsert({
        user_id: read.userId,
        started_at: new Date().toISOString(),
        ends_at: row.expires_at,
      }, { onConflict: 'user_id' });
      if (markError) return reply(500, { error: `The trial was set but not recorded: ${markError.message}` });
    }

    console.log(`[admin-accounts] ${caller.email} set ${read.userId} to ${read.plan}`
      + ` until ${row.expires_at || 'forever'}`);
    return reply(200, { ok: true, plan: read.plan });
  }

  /*
   * Delete: rows first, then the auth record.
   *
   * The same order as the self-service path, and for the same reason. Deleting
   * the user first leaves the folders behind with no session able to reach
   * them, and only another service-key call could clean them up.
   */
  const { error: rowsError } = await admin.from(TABLE).delete().eq('user_id', read.userId);
  if (rowsError) return reply(500, { error: `Could not delete their folders: ${rowsError.message}` });

  const { error: rightsError } = await admin.from('entitlements').delete().eq('user_id', read.userId);
  if (rightsError) return reply(500, { error: `Could not delete their plan: ${rightsError.message}` });

  // The trial record goes with the account, unlike every other path here,
  // where it deliberately survives. Both rows would cascade off the auth
  // record anyway; they are deleted by name so that a failure is reported
  // rather than discovered later as a row pointing at nobody.
  const { error: trialError } = await admin.from('trials').delete().eq('user_id', read.userId);
  if (trialError) return reply(500, { error: `Could not delete their trial record: ${trialError.message}` });

  const { error: userError } = await admin.auth.admin.deleteUser(read.userId);
  if (userError) return reply(500, { error: `Could not delete the account: ${userError.message}` });

  console.warn(`[admin-accounts] ${caller.email} deleted ${read.email} (${read.userId})`);
  return reply(200, { ok: true, deleted: read.userId });
});
