/**
 * Start a Stripe Checkout for the person who is signed in.
 *
 * Halfstop can be used in a browser, and an App Store subscription cannot be
 * bought in one. Without this, anybody who is not on an iPhone has no way to
 * pay at all.
 *
 * WHO IS PAYING IS NOT TAKEN FROM THE REQUEST
 *
 * The user id comes from the verified token on the caller's own session, never
 * from the body. A function that accepted "make this user a subscriber" from
 * whatever posted to it would let anybody buy a subscription for somebody
 * else's account, or - far worse in the other direction - point their own
 * payment at an account they do not own.
 *
 * The id is written onto the Subscription's metadata rather than only onto the
 * Checkout Session, because every later event - renewed, cancelled, payment
 * failed - carries the subscription and not the session. Putting it only on
 * the session means the first event knows who this is and none of the rest do.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

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

/** Stripe's API speaks form encoding, including for nested keys. */
function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const url = env('SUPABASE_URL');
  const publishable = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const stripeKey = env('STRIPE_SECRET_KEY');
  const priceId = env('STRIPE_PRICE_ID');
  if (!url || !publishable) return reply(500, { error: 'This function is missing its Supabase environment.' });
  if (!stripeKey || !priceId) return reply(503, { error: 'Payments are not configured on this project.' });

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
    // A checkout with no options is the ordinary case, so an empty body is not
    // an error. Only the return address is ever read from it.
  }

  /*
   * Where to send somebody afterwards, checked rather than trusted.
   *
   * An open redirect here would be a phishing page with our own domain in the
   * referrer and a payment just behind it. Only our own site is accepted, and
   * anything else falls back to it rather than being honoured.
   */
  const site = env('SITE_URL') || 'https://app.halfstop.app/';
  const asked = String(body.returnTo || '');
  const returnTo = asked.startsWith(site) ? asked : site;

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Two presses of the button are one checkout, not two subscriptions.
      'Idempotency-Key': `checkout:${user.id}:${new Date().toISOString().slice(0, 13)}`,
    },
    body: form({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${returnTo}${returnTo.includes('?') ? '&' : '?'}subscribed=1`,
      cancel_url: returnTo,
      // Prefilled so nobody pays under an address that is not their account,
      // which is the commonest way a payment ends up attached to nothing.
      customer_email: String(user.email || ''),
      client_reference_id: user.id,
      'metadata[supabase_user_id]': user.id,
      // The one that matters: every later event carries the subscription
      // rather than the session, so the id has to live on the subscription.
      'subscription_data[metadata][supabase_user_id]': user.id,
    }),
  });

  const session = await response.json();
  if (!response.ok) {
    console.warn('[stripe-checkout] Stripe refused:', JSON.stringify(session?.error || session));
    return reply(502, { error: 'The payment provider refused to start a checkout.' });
  }

  return reply(200, { ok: true, url: session.url });
});
