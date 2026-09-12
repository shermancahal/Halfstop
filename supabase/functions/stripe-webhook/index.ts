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

/** Seconds from Stripe, as an ISO string, or null when there is no end. */
function endsAt(seconds: unknown): string | null {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

/**
 * Which Stripe statuses mean "this person may use the thing".
 *
 * `past_due` is deliberately included. A card that failed on Tuesday is
 * somebody Stripe is still retrying and still considers a customer, and
 * switching their maps off mid-trip over a retry that usually succeeds is a
 * worse mistake than a few days of unpaid access.
 */
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

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

  const object = event?.data?.object || {};
  const type = String(event?.type || '');

  // A checkout that completed has the subscription in hand but not its status,
  // so the subscription events are the ones that decide. This is only here to
  // catch the very first one, where the two arrive close together.
  const userId = String(
    object?.metadata?.supabase_user_id
      || object?.subscription_details?.metadata?.supabase_user_id
      || object?.client_reference_id
      || '',
  );
  if (!userId) {
    // Answered 200 on purpose: it is a real event about something that is not
    // ours, and a 4xx would have Stripe retry it for days.
    console.warn(`[stripe-webhook] ${type} carries no supabase_user_id; ignoring.`);
    return reply(200, { ok: true, ignored: 'no user' });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (type === 'customer.subscription.deleted') {
    // Ended rather than deleted, so the history of what somebody had is not
    // lost and my_plan() falls through to free on the next read.
    const { error } = await admin.from('entitlements')
      .update({ expires_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('source', 'stripe');
    if (error) return reply(500, { error: `Could not end it: ${error.message}` });
    console.log(`[stripe-webhook] ended for ${userId}`);
    return reply(200, { ok: true });
  }

  if (type === 'customer.subscription.created' || type === 'customer.subscription.updated'
    || type === 'checkout.session.completed') {
    const status = String(object.status || 'active');
    const live = type === 'checkout.session.completed' ? true : ACTIVE.has(status);

    const { error } = await admin.from('entitlements').upsert({
      user_id: userId,
      tier: 'premium',
      source: 'stripe',
      // Ended now rather than nulled, because null means "never expires" and
      // a cancelled subscription is the opposite of that.
      expires_at: live
        ? endsAt(object.current_period_end)
        : new Date().toISOString(),
      external_ref: String(object.id || ''),
      note: `Stripe ${status}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) return reply(500, { error: `Could not record it: ${error.message}` });

    console.log(`[stripe-webhook] ${type} ${status} for ${userId}`);
    return reply(200, { ok: true });
  }

  // Everything else Stripe sends is fine and none of our business. 200 so it
  // is not retried.
  return reply(200, { ok: true, ignored: type });
});
