/**
 * Google Play subscriptions: recorded when bought, kept current after.
 *
 * Two callers, one function, because they do one job - ask Google what a
 * purchase token is, and write that down - and a second function would mean
 * a second copy of the part that decides who gets Premium.
 *
 *   POST /play-billing            from the Android app, signed in, right after
 *                                 a purchase: { purchaseToken }
 *   POST /play-billing/notify     from Google Cloud Pub/Sub, whenever the
 *                                 subscription changes: renewed, cancelled,
 *                                 on hold, refunded, expired
 *
 * The gateway's JWT check is off (config.toml) because Pub/Sub has no Supabase
 * session. The app's path checks the caller itself, the same way every other
 * function here reads who is asking: auth.getUser() on the bearer token, which
 * Supabase Auth verifies. The notification path is checked by a shared secret
 * in its URL - and, more to the point, believes nothing it is sent.
 *
 * NOTHING SENT HERE IS BELIEVED
 *
 * Both callers only name a purchase token. What it bought, for which account
 * and until when is read from Google's Android Publisher API with this
 * project's service account. See google.mjs and decide.mjs, which are plain
 * JavaScript and tested.
 *
 * Secrets (Edge Functions -> Secrets):
 *   PLAY_SERVICE_ACCOUNT   the service account's JSON key, whole
 *   PLAY_NOTIFY_TOKEN      a long random string, also in the Pub/Sub push URL
 *   PLAY_PACKAGE_NAME      optional, defaults to com.halfstop.app
 *   PLAY_PRODUCT_ID        optional, defaults to premium
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { accessToken, acknowledge, getSubscription, serviceAccountFrom } from './google.mjs';
import { claimedBy, decideWrite, readNotification, readSubscription, tokenMatches } from './decide.mjs';

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

const PACKAGE = () => env('PLAY_PACKAGE_NAME') || 'com.halfstop.app';
const PRODUCT = () => env('PLAY_PRODUCT_ID') || 'premium';

type Outcome = { action: string; why: string; row?: Record<string, unknown>; userId?: string; read?: Record<string, any> };

/**
 * Ask Google about one token and bring the row into line with the answer.
 *
 * Shared by both paths. `expectUser`, when given, is the signed-in caller:
 * the purchase must name them, or it is somebody else's token being handed in.
 */
async function settle(
  admin: ReturnType<typeof createClient>,
  purchaseToken: string,
  { expectUser = '', voided = false } = {},
): Promise<Outcome> {
  const account = serviceAccountFrom(env('PLAY_SERVICE_ACCOUNT'));
  if (!account) throw Object.assign(new Error('PLAY_SERVICE_ACCOUNT is missing or is not a service account key.'), { status: 503 });

  const bearer = await accessToken(account);
  const subscription = await getSubscription({ accessToken: bearer, packageName: PACKAGE(), purchaseToken });
  if (!subscription) return { action: 'ignore', why: 'Google does not know that purchase' };

  const read = readSubscription(subscription, { productId: PRODUCT() });
  if (expectUser && !claimedBy(read, expectUser)) {
    return { action: 'foreign', why: 'the purchase names a different account', read };
  }

  /*
   * A failed read is thrown, never taken as "no row". Read as none, a
   * database having a bad second would let a Play purchase write over a
   * Stripe subscription that is still charging - the one outcome decide.mjs
   * exists to refuse.
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

  const decided = decideWrite(read, held, { purchaseToken, voided });

  if (decided.action === 'write') {
    const { error } = await admin.from('entitlements').upsert(decided.row, { onConflict: 'user_id' });
    if (error) throw new Error(`Could not record it: ${error.message}`);
  } else if (decided.action === 'end') {
    const { error } = await admin.from('entitlements')
      .update({ expires_at: new Date().toISOString(), renews: false, note: 'Google Play voided', updated_at: new Date().toISOString() })
      .eq('user_id', read.userId).eq('source', 'play').eq('external_ref', purchaseToken);
    if (error) throw new Error(`Could not end it: ${error.message}`);
  }

  /*
   * Acknowledged only once it is on record, and only when it grants. A
   * purchase refused as a second subscription is left unacknowledged on
   * purpose: Google refunds it in three days, which is the correct outcome for
   * a charge this project will not honour, and needs nobody to remember to
   * issue it.
   */
  if (decided.action === 'write' && read.entitled && read.needsAck) {
    try {
      await acknowledge({ accessToken: bearer, packageName: PACKAGE(), productId: PRODUCT(), purchaseToken });
    } catch (error) {
      // Recorded and not acknowledged is recoverable - the next notification
      // or the next call from the app tries again. Said in the log, because
      // three days of silence ends in a refund.
      console.error(`[play-billing] recorded but NOT acknowledged for ${read.userId}: ${(error as Error).message}`);
    }
  }

  console.log(`[play-billing] ${decided.action} for ${read.userId || 'nobody'}: ${decided.why}`);
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

  /* ------------------------------------------- Google, via Pub/Sub push */
  if (path.endsWith('/notify')) {
    const secret = env('PLAY_NOTIFY_TOKEN');
    if (!secret) return reply(503, { error: 'This endpoint has no shared secret, so it accepts nothing.' });
    if (!tokenMatches(new URL(req.url).searchParams.get('token'), secret)) {
      console.warn('[play-billing] notification refused: wrong or missing token');
      return reply(401, { error: 'No.' });
    }

    let envelope: unknown = null;
    try {
      envelope = await req.json();
    } catch {
      // 200, not 400: Pub/Sub retries anything else for a week, and a body
      // that is not JSON will not become JSON on the next attempt.
      return reply(200, { ok: true, ignored: 'not JSON' });
    }
    const note = readNotification(envelope);
    if (note.kind === 'test') {
      console.log('[play-billing] test notification from Play Console received');
      return reply(200, { ok: true, test: true });
    }
    if (note.kind === 'other' || !note.purchaseToken) return reply(200, { ok: true, ignored: 'nothing to act on' });
    if (note.packageName && note.packageName !== PACKAGE()) return reply(200, { ok: true, ignored: 'another app' });

    try {
      const outcome = await settle(admin, note.purchaseToken, { voided: note.kind === 'voided' });
      return reply(200, { ok: true, action: outcome.action });
    } catch (error) {
      // 500 so Pub/Sub delivers it again: this is Google or the database
      // having a bad minute, and the notification is still true.
      console.error(`[play-billing] notification failed: ${(error as Error).message}`);
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
    /* handled below as no token */
  }
  const purchaseToken = String(body.purchaseToken || '').trim();
  if (!purchaseToken || purchaseToken.length > 4096) return reply(400, { error: 'There was no purchase to record.' });

  let outcome: Outcome;
  try {
    outcome = await settle(admin, purchaseToken, { expectUser: user.id });
  } catch (error) {
    const status = (error as { status?: number }).status || 502;
    console.error(`[play-billing] could not settle a purchase for ${user.id}: ${(error as Error).message}`);
    return reply(status, {
      error: status === 503
        ? 'Google Play payments are not configured on this project yet.'
        : 'Google Play could not be asked about that purchase just now. It is not lost: '
          + 'Premium turns on by itself when Google next reports on it.',
    });
  }

  if (outcome.action === 'foreign') {
    return reply(403, { error: 'That Google Play purchase belongs to a different Halfstop account.' });
  }
  if (outcome.action === 'conflict') {
    const elsewhere = outcome.why.includes('appstore') ? 'the App Store' : 'the website';
    return reply(409, {
      error: `This account already subscribes through ${elsewhere}, so this Google Play purchase has not `
        + 'been confirmed, and Google refunds it automatically within three days. To pay through '
        + `Google Play instead, cancel the subscription through ${elsewhere} first.`,
    });
  }
  if (outcome.read?.pending) {
    return reply(202, {
      ok: false, pending: true,
      error: 'Google Play is waiting for that payment to go through. Premium turns on by itself when it does.',
    });
  }
  if (outcome.action !== 'write' || !outcome.read?.entitled) {
    return reply(409, { error: `Google Play does not show that purchase as active (${outcome.why}).` });
  }
  return reply(200, { ok: true, until: outcome.row?.expires_at || null });
});
