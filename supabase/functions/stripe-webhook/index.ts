/**
 * Stripe says somebody paid, or stopped paying, and the row follows.
 *
 * WHY THIS ONE IS NOT BEHIND A JWT
 *
 * Stripe has no session and never will, so this is deployed with verify_jwt
 * off and authorises the caller itself. Everything protecting it is in
 * ./signature.mjs, which is plain JavaScript and unit tested on a laptop,
 * because a permissive bug there does not show up as a failure - it shows up
 * as strangers with subscriptions.
 *
 * WHO THE EVENT IS ABOUT
 *
 * Read from the metadata the checkout wrote onto the Subscription, never from
 * an email address. Two accounts can share an address at a payment provider,
 * and matching on one would attach a stranger's payment to whichever row was
 * found first.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { verify } from './signature.mjs';
import { readEvent } from './events.mjs';

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

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const secret = env('STRIPE_WEBHOOK_SECRET');
  if (!secret) return reply(503, { error: 'This endpoint has no signing secret, so it accepts nothing.' });

  /*
   * The exact bytes Stripe sent, read once as text.
   *
   * The signature is over the characters rather than over the meaning, so
   * parsing first and re-serialising - which changes key order and whitespace
   * - would fail every time, and "fixing" that by skipping the check is how
   * this endpoint would end up open.
   */
  const payload = await req.text();
  const check = await verify(payload, req.headers.get('Stripe-Signature'), secret);
  if (!check.ok) {
    console.warn(`[stripe-webhook] refused: ${check.reason}`);
    return reply(401, { error: 'No.' });
  }

  const url = env('SUPABASE_URL');
  const serviceKey = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return reply(500, { error: 'This function is missing its Supabase environment.' });

  let event: Record<string, any>;
  try {
    event = JSON.parse(payload);
  } catch {
    return reply(400, { error: 'That was not JSON.' });
  }

  /*
   * What this event means is decided in events.mjs, which is pure and tested.
   *
   * It was inline here, and reading it carefully was not enough: a completed
   * checkout granted permanent Premium, because a Checkout Session has no
   * period end, so the expiry came out null and null means never expires.
   */
  const read = readEvent(event);
  if (read.action === 'ignore') {
    // 200 rather than a 4xx. It is a real event about something that is not
    // ours, and a rejection would have Stripe retry it for days.
    console.log(`[stripe-webhook] ignoring ${event?.type}: ${read.why}`);
    return reply(200, { ok: true, ignored: read.why });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (read.action === 'end') {
    /*
     * Ended, not deleted, and only ever a row this provider owns.
     *
     * The `source` filter is what stops a Stripe cancellation reaching into an
     * App Store subscription that happens to be on the same account.
     */
    const { error } = await admin.from('entitlements')
      .update({ expires_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('user_id', read.userId)
      .eq('source', 'stripe');
    if (error) return reply(500, { error: `Could not end it: ${error.message}` });
    console.log(`[stripe-webhook] ended for ${read.userId}: ${read.why}`);
    return reply(200, { ok: true });
  }

  const { error } = await admin.from('entitlements').upsert({
    user_id: read.userId,
    tier: 'premium',
    source: 'stripe',
    expires_at: read.expiresAt,
    external_ref: read.externalRef,
    note: `Stripe ${read.status}`,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) return reply(500, { error: `Could not record it: ${error.message}` });

  console.log(`[stripe-webhook] ${event?.type} ${read.status} for ${read.userId} until ${read.expiresAt}`);
  return reply(200, { ok: true });
});
