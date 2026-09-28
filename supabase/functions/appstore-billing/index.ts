/**
 * App Store subscriptions: recorded when bought, kept current after.
 *
 * The twin of play-billing, and built the same way on purpose. Two callers,
 * one function, because they do one job - ask Apple what a transaction is,
 * and write that down:
 *
 *   POST /appstore-billing          from the iPhone app, signed in, right after
 *                                   a purchase: { transactionId }
 *   POST /appstore-billing/notify   App Store Server Notifications V2, whenever
 *                                   the subscription changes: renewed,
 *                                   cancelled, in grace, refunded, expired
 *
 * The gateway's JWT check is off (config.toml) because Apple has no Supabase
 * session. The app's path checks the caller itself, with auth.getUser() on
 * the bearer token. The notification path is checked by a shared secret in
 * its URL - and, more to the point, believes nothing it is sent.
 *
 * NOTHING SENT HERE IS BELIEVED
 *
 * Both callers only name a transaction. Whose it is, which product and until
 * when is read from Apple's App Store Server API with this project's In-App
 * Purchase key. See apple.mjs and decide.mjs, which are plain JavaScript and
 * tested.
 *
 * Secrets (Edge Functions -> Secrets):
 *   APPSTORE_KEY            the In-App Purchase key's .p8 file, whole
 *   APPSTORE_KEY_ID         its Key ID, from App Store Connect
 *   APPSTORE_ISSUER_ID      the Issuer ID on the same page
 *   APPSTORE_NOTIFY_TOKEN   a long random string, also in the notification URL
 *   APPSTORE_BUNDLE_ID      optional, defaults to com.halfstop.app
 *   APPSTORE_PRODUCT_IDS    optional, defaults to premium.monthly,premium.yearly
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { apiKeyFrom, getSubscriptionStatuses, signedApiToken } from './apple.mjs';
import { claimedBy, decideWrite, readNotification, readStatus, tokenMatches } from './decide.mjs';

/** Trimmed, because a value pasted into a dashboard field brings whitespace. */
function env(name: string): string {
  return (Deno.env.get(name) || '').trim();
}

function keyFrom(jsonName: string, legacyName: string): string {
  const bundle = env(jsonName);
  if (bundle) {
    try {
      const keys = JSON.parse(bundle);
      const value = keys.default || Object.values(keys)[0];
      if (typeof value === 'string' && value) return value;
    } catch {
      // Fall through to the legacy name rather than failing on a shape change.
    }
  }
  return env(legacyName);
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

const BUNDLE = () => env('APPSTORE_BUNDLE_ID') || 'com.halfstop.app';
const PRODUCTS = () => (env('APPSTORE_PRODUCT_IDS') || 'premium.monthly,premium.yearly')
  .split(',').map((id) => id.trim()).filter(Boolean);

type Outcome = { action: string; why: string; row?: Record<string, unknown>; userId?: string; read?: Record<string, any> };

/**
 * Ask Apple about one transaction and bring the row into line with the answer.
 *
 * Shared by both paths. `expectUser`, when given, is the signed-in caller:
 * the purchase must name them, or it is somebody else's transaction being
 * handed in.
 */
async function settle(
  admin: ReturnType<typeof createClient>,
  transactionId: string,
  { expectUser = '' } = {},
): Promise<Outcome> {
  const key = apiKeyFrom(env('APPSTORE_KEY'));
  const keyId = env('APPSTORE_KEY_ID');
  const issuerId = env('APPSTORE_ISSUER_ID');
  if (!key || !keyId || !issuerId) {
    throw Object.assign(new Error('APPSTORE_KEY, APPSTORE_KEY_ID or APPSTORE_ISSUER_ID is missing.'), { status: 503 });
  }

  const token = await signedApiToken({ key, keyId, issuerId, bundleId: BUNDLE() });
  const statuses = await getSubscriptionStatuses({ token, transactionId });
  if (!statuses) return { action: 'ignore', why: 'Apple does not know that transaction' };

  const read = readStatus(statuses, { bundleId: BUNDLE(), productIds: PRODUCTS() });
  if (expectUser && !claimedBy(read, expectUser)) {
    return { action: 'foreign', why: 'the purchase names a different account', read };
  }

  /*
   * A failed read is thrown, never taken as "no row" - read as none, a
   * database having a bad second would let an App Store purchase write over a
   * subscription still being charged somewhere else.
   */
  let held = null;
  if (read.userId) {
    const found = await admin.from('entitlements')
      .select('source, external_ref, expires_at')
      .eq('user_id', read.userId)
      .maybeSingle();
    if (found.error) throw new Error(`Could not read the entitlement: ${found.error.message}`);
    held = found.data;
  }

  const decided = decideWrite(read, held);
  if (decided.action === 'write') {
    const { error } = await admin.from('entitlements').upsert(decided.row, { onConflict: 'user_id' });
    if (error) throw new Error(`Could not record it: ${error.message}`);
  }
  console.log(`[appstore-billing] ${decided.action} for ${read.userId || 'nobody'}: ${decided.why}`);
  return { ...decided, userId: read.userId, read };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const url = env('SUPABASE_URL');
  const serviceKey = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  const publishable = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  if (!url || !serviceKey || !publishable) return reply(500, { error: 'This function is missing its Supabase environment.' });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const path = new URL(req.url).pathname;

  /* ----------------------------------- Apple, App Store Server Notifications */
  if (path.endsWith('/notify')) {
    const secret = env('APPSTORE_NOTIFY_TOKEN');
    if (!secret) return reply(503, { error: 'This endpoint has no shared secret, so it accepts nothing.' });
    if (!tokenMatches(new URL(req.url).searchParams.get('token'), secret)) {
      console.warn('[appstore-billing] notification refused: wrong or missing token');
      return reply(401, { error: 'No.' });
    }

    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      // 200, not 400: Apple retries anything else for days, and a body that
      // is not JSON will not become JSON on the next attempt.
      return reply(200, { ok: true, ignored: 'not JSON' });
    }
    const note = readNotification(body);
    if (note.kind === 'test') {
      console.log('[appstore-billing] test notification from App Store Connect received');
      return reply(200, { ok: true, test: true });
    }
    if (note.kind === 'other' || !note.transactionId) return reply(200, { ok: true, ignored: 'nothing to act on' });
    if (note.bundleId && note.bundleId !== BUNDLE()) return reply(200, { ok: true, ignored: 'another app' });

    try {
      const outcome = await settle(admin, note.transactionId);
      return reply(200, { ok: true, action: outcome.action });
    } catch (error) {
      // 500 so Apple delivers it again: this is Apple or the database having
      // a bad minute, and the notification is still true.
      console.error(`[appstore-billing] notification ${note.type} failed: ${(error as Error).message}`);
      return reply(500, { error: (error as Error).message });
    }
  }

  /* ------------------------------------------ the app, after a purchase */
  const authorization = req.headers.get('Authorization') || '';
  if (!authorization) return reply(401, { error: 'Sign in first.' });
  const asCaller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoError } = await asCaller.auth.getUser();
  const user = who?.user;
  if (whoError || !user) return reply(401, { error: 'That session is not valid.' });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* handled below as no transaction */
  }
  const transactionId = String(body.transactionId || '').trim();
  if (!/^\d{1,32}$/.test(transactionId)) return reply(400, { error: 'There was no purchase to record.' });

  let outcome: Outcome;
  try {
    outcome = await settle(admin, transactionId, { expectUser: user.id });
  } catch (error) {
    const status = (error as { status?: number }).status || 502;
    console.error(`[appstore-billing] could not settle a purchase for ${user.id}: ${(error as Error).message}`);
    return reply(status === 503 ? 503 : 502, {
      error: status === 503
        ? 'App Store payments are not configured on this project yet.'
        : 'The App Store could not be asked about that purchase just now. It is not lost: '
          + 'Premium turns on by itself when Apple next reports on it.',
    });
  }

  if (outcome.action === 'foreign') {
    return reply(403, { error: 'That App Store purchase belongs to a different Halfstop account.' });
  }
  if (outcome.action === 'conflict') {
    /*
     * Apple, unlike Google, has no "refund it if it is not acknowledged": the
     * charge stands. So the sentence says how to get the money back as well
     * as why it was not recorded.
     */
    const elsewhere = outcome.why.includes('play') ? 'Google Play' : 'the website';
    return reply(409, {
      error: `This account already subscribes through ${elsewhere}, so this App Store purchase has not `
        + 'been recorded. Ask Apple for a refund at reportaproblem.apple.com, or cancel the subscription '
        + `through ${elsewhere} and Premium will carry on through the App Store.`,
    });
  }
  if (outcome.action !== 'write' || !outcome.read?.entitled) {
    return reply(409, { error: `The App Store does not show that purchase as active (${outcome.why}).` });
  }
  return reply(200, { ok: true, until: outcome.row?.expires_at || null });
});
