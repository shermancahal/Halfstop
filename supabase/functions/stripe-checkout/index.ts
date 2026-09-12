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

/**
 * The API version these calls speak, pinned rather than inherited.
 *
 * Without this header Stripe uses the account's default version, which is
 * whatever the account was created under. On this account that is 2015-02-10,
 * and Checkout Sessions did not exist in 2015: `mode`, `line_items` and
 * `subscription_data` are all newer than the version the calls would otherwise
 * have been made under.
 *
 * Pinning also means a future account-wide version change cannot quietly alter
 * what these functions send or receive. Raising it is then a deliberate edit
 * here, tested, rather than a setting somebody flips in a dashboard.
 */
const STRIPE_VERSION = '2024-06-20';

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
  if (!url || !publishable) return reply(500, { error: 'This function is missing its Supabase environment.' });
  if (!stripeKey) return reply(503, { error: 'Payments are not configured on this project.' });

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization) return reply(401, { error: 'Sign in first.' });

  const asCaller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoError } = await asCaller.auth.getUser();
  const user = who?.user;
  if (whoError || !user) return reply(401, { error: 'That session is not valid.' });

  /*
   * Somebody who already subscribes is not sold a second one.
   *
   * The App Store and Stripe do not know about each other, and the
   * entitlements row is one per account, so a second purchase would overwrite
   * the first: two charges a month, only one of them visible, and cancelling
   * the visible one takes away access that the invisible one is still paying
   * for. Nobody would ever untangle that from the outside.
   *
   * Read through the caller's own session rather than with the service key.
   * The row policy already lets somebody read their own entitlement and
   * nobody else's, so using it here means this function cannot accidentally
   * become a way to ask about another account.
   */
  const { data: held } = await asCaller
    .from('entitlements')
    .select('source, expires_at')
    .eq('user_id', user.id)
    .eq('tier', 'premium')
    .maybeSingle();

  const stillRunning = held && (!held.expires_at || new Date(held.expires_at) > new Date());
  if (stillRunning) {
    const WHERE: Record<string, string> = {
      stripe: 'You already subscribe. Cancel the current subscription first, '
        + 'from Manage subscription in the account menu, and you can start a new one straight after.',
      appstore: 'You already subscribe through the App Store. Cancel it there first '
        + '(Settings, your name, Subscriptions on an iPhone), and it will stay active until the period you have paid for runs out.',
    };
    return reply(409, {
      error: WHERE[held.source]
        || 'This account already has Premium, so there is nothing to buy.',
      already: held.source,
    });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // A checkout with no options is the ordinary case, so an empty body is not
    // an error. Only a plan name and a return address are read from it.
  }

  /*
   * A plan name, never a price.
   *
   * The client says 'month' or 'year' and this maps it to an id held here. A
   * checkout that accepted a Stripe price id from the browser would be a
   * checkout where anybody can name what they pay: make a one cent price in
   * any Stripe account, pass its id, and buy a year of Premium for a penny.
   *
   * So the map is closed. Anything that is not one of these two names is
   * refused rather than defaulted, because defaulting would charge somebody
   * for a plan they did not ask for.
   */
  const PRICES: Record<string, string> = {
    month: env('STRIPE_PRICE_ID_MONTH') || env('STRIPE_PRICE_ID'),
    year: env('STRIPE_PRICE_ID_YEAR'),
  };
  const plan = String(body.plan || 'month');
  // Checked before it is read, not after. Reading first works today and is
  // the shape that quietly becomes a bug the moment somebody moves the check.
  if (!Object.hasOwn(PRICES, plan)) return reply(400, { error: 'That is not a plan.' });
  const priceId = PRICES[plan];
  if (!priceId) return reply(503, { error: `The ${plan} plan is not configured on this project.` });

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
      'Stripe-Version': STRIPE_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Two presses of the button are one checkout, not two subscriptions.
      'Idempotency-Key': `checkout:${user.id}:${plan}:${new Date().toISOString().slice(0, 13)}`,
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
