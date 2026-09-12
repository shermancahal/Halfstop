/**
 * A door out, on Stripe's own pages.
 *
 * Cancelling has to be as easy as subscribing, and it has to be self-service.
 * A subscription you can only end by emailing somebody is the pattern every
 * consumer protection regime has spent a decade legislating against, and it is
 * also just unpleasant. Stripe's billing portal handles cancelling, changing
 * between the monthly and yearly price, updating a card and downloading past
 * invoices, on Stripe's domain, so none of that is built or held here.
 *
 * Which customer it opens is read from the verified token on the caller's own
 * session. A body naming a customer would be a body somebody else can write,
 * and the portal can cancel a subscription.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

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

const form = (fields: Record<string, string>) => Object.entries(fields)
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  .join('&');

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

  const { data: held } = await asCaller
    .from('entitlements')
    .select('source, external_ref')
    .eq('user_id', user.id)
    .maybeSingle();

  if (held?.source === 'appstore') {
    return reply(409, {
      error: 'This subscription is through the App Store, so it is cancelled there: '
        + 'Settings, your name, Subscriptions on an iPhone or iPad.',
      where: 'appstore',
    });
  }
  if (held?.source !== 'stripe' || !held.external_ref) {
    return reply(404, { error: 'There is no subscription on this account to manage.' });
  }

  /*
   * The customer is found from the subscription rather than stored separately.
   *
   * One id on the row instead of two means they cannot disagree, and the
   * subscription is the thing the row is actually about. The extra call is one
   * request on a page somebody opens rarely.
   */
  const found = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(held.external_ref)}`, {
    headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': STRIPE_VERSION },
  });
  const subscription = await found.json();
  if (!found.ok || !subscription?.customer) {
    console.warn('[stripe-portal] could not read the subscription:', JSON.stringify(subscription?.error || subscription));
    return reply(502, { error: 'The payment provider could not find that subscription.' });
  }

  const site = env('SITE_URL') || 'https://app.halfstop.app/';
  const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Stripe-Version': STRIPE_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form({ customer: String(subscription.customer), return_url: site }),
  });

  const session = await response.json();
  if (!response.ok) {
    console.warn('[stripe-portal] Stripe refused:', JSON.stringify(session?.error || session));
    return reply(502, { error: 'The payment provider could not open the billing page.' });
  }

  return reply(200, { ok: true, url: session.url });
});
