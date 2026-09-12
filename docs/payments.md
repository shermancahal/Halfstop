# Taking money: what has to be set outside this repository

Nothing here is switched on. `BILLING.live` is false and `BILLING.store` is
`'none'`, so every account has every feature and the plan panel draws no
buttons. This file is what to do when that changes.

Two providers, one row. `public.entitlements` has a `source` column for
exactly this reason: the App Store can only sell inside a shipped app, and
anybody using Halfstop in a browser has no way to pay through it. Stripe is
that way, and Apple permits it — a subscription bought elsewhere may be
honoured in the app, as long as the app does not send people out to buy it and
does not advertise the outside price.

---

## What the prices are

`BILLING.plans` in `assets/js/config.js`, in cents:

| Plan | Price | Stripe interval |
| --- | --- | --- |
| `month` | $4.99 | monthly |
| `year` | $49 | yearly |

Paying by the year saves $10.88, about 18%. That figure is computed by
`annualSaving()` rather than written down, so it cannot overstate the discount
or go stale when a price moves. A test also fails if the website stops saying
what the config says.

**The browser never sends a price.** It sends the plan's name, `month` or
`year`, and `stripe-checkout` maps that to an id it holds. A checkout that took
a Stripe price id from the client would be one where anybody can make a one
cent price in any Stripe account, pass its id, and buy a year for a penny.

---

## Stripe, in the order it has to be done

### 1. The product and its two prices

Stripe Dashboard → **Product catalogue** → **Add product**.

- Name **Halfstop Premium**. The description is shown at checkout.
- Add a **recurring** price of **$4.99 USD, monthly**.
- Add a **second** recurring price on the *same product*: **$49 USD, yearly**.

Two prices on one product, not two products. It is what lets somebody move
between monthly and yearly later without it looking like a different thing they
have to cancel and rebuy.

Copy both price ids. They look like `price_1AbC...`, and they are not secret —
the secret key is.

### 2. The keys, in Supabase

They all go in the same place: Supabase Dashboard → your project → **Edge
Functions** → **Secrets** → **Add new secret**. Set once, read by every
function; they are not per-function.

**`STRIPE_SECRET_KEY`** — Stripe Dashboard → **Developers** → **API keys**.
There are two on that page. The *publishable* key (`pk_...`) is the one meant
to be seen and is not what you want. The **secret key** (`sk_...`) is hidden
behind a **Reveal** button and is shown once; if you have lost it, roll it and
take the new one. Use the **test mode** key first — there is a toggle at the
top of the Stripe dashboard, and in test mode the key reads `sk_test_...`. Swap
it for the live key when you are ready to take real money, and remember the
price ids and the webhook secret are *different* between test and live.

**`STRIPE_PRICE_ID_MONTH`** and **`STRIPE_PRICE_ID_YEAR`** — from the product
you made in step 1. Stripe Dashboard → **Product catalogue** → **Halfstop
Premium**. The two prices are listed on that page; each row has a `price_1...`
id with a copy button beside it. The monthly one goes in `..._MONTH`, the
yearly in `..._YEAR`. Getting them the wrong way round charges somebody $49 for
a month, and nothing in the code can tell, so read them twice.

These two are not secrets — a price id is safe to put in a page. They are held
here anyway so the browser cannot name its own price.

**`STRIPE_WEBHOOK_SECRET`** — this one does not exist until step 4, so do that
first and come back. Stripe Dashboard → **Developers** → **Webhooks** → click
the endpoint you created → **Signing secret** → **Reveal**. It reads
`whsec_...`. It belongs to that one endpoint: a second endpoint, or the same
one in live mode rather than test, has a different secret.

Paste carefully. A trailing newline in a dashboard field is invisible there and
a different string everywhere else; it cost a round of debugging on the support
webhook, which is why every function here trims what it reads.

> Check the mode. The commonest way this fails silently is a live-mode key with
> test-mode price ids, or the other way round. Stripe will refuse with "no such
> price", which is accurate and reads like the price does not exist.

### 3. Deploy the two functions

```sh
supabase functions deploy stripe-checkout
supabase functions deploy stripe-portal
supabase functions deploy stripe-webhook --no-verify-jwt
```

`supabase/config.toml` already records both settings, so a deploy from the
repository root gets them right without the flag.

The `--no-verify-jwt` on the webhook is not an oversight. Stripe has no session
and never will, so that endpoint authorises its own caller with the signature
on the request. All of that lives in `stripe-webhook/signature.mjs`, which is
plain JavaScript so it can be unit tested here rather than in production: a
tampered body, a wrong secret, a replay outside the tolerance, a future
timestamp, a missing secret, the test-mode `v0` scheme, and a rotating secret
sending two signatures. A permissive bug there does not look like a failure. It
looks like strangers with subscriptions.

### 4. The webhook

Stripe → **Developers → Webhooks → Add endpoint**.

- URL: `https://gqemcvuushtfbbbxypvf.supabase.co/functions/v1/stripe-webhook`
- Events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`.

Then copy the **signing secret** it shows you into `STRIPE_WEBHOOK_SECRET` and
redeploy the function so it picks the value up.

Subscribe to those four and no more. Every other event is answered 200 and
ignored, so adding them only makes the log harder to read.

### 5. Turn it on

In `assets/js/config.js`:

```js
export const BILLING = {
  live: true,
  store: 'stripe',
  ...
};
```

`live: true` closes the feature gates. `store: 'stripe'` is what puts the two
buttons in the plan panel. They are separate on purpose: the gates can be
proven with billing live and nothing for sale.

### 6. Test it before anybody real does

Use the test key and Stripe's test cards — `4242 4242 4242 4242`, any future
expiry, any CVC. Then check, in this order:

1. The checkout opens on Stripe's own domain.
2. After paying, the row appears: `select * from public.entitlements where source = 'stripe'`.
3. `select public.my_plan()` as that user says `premium` with `source: 'stripe'`.
4. Cancel in the Stripe dashboard and watch `expires_at` move to now.

`stripe listen --forward-to <url>` replays events locally if something in the
middle is not firing.

---

## Cancelling

`stripe-portal` opens Stripe's own billing pages for whoever is signed in,
which is where a subscription is ended, moved between monthly and yearly, or
given a new card. None of that is built here, and it should not be: a
subscription you can only end by writing to somebody is the pattern consumer
protection law has spent a decade legislating against, and it is unpleasant
besides.

Which customer the portal opens is read from the verified token on the caller's
session. A body naming a customer would be a body somebody else can write, and
the portal can cancel a subscription.

The customer is looked up from the subscription id on the entitlements row
rather than stored separately: one id instead of two means they cannot
disagree, at the cost of one request on a page somebody opens rarely.

**An App Store subscription cannot be cancelled from here**, and the function
says so rather than failing. Only Apple can end one.

The policy people actually read is in `terms.html` under *Cancelling* and in
the FAQ under *Account*. In short: cancelling stops the next payment rather
than cutting anybody off, Premium runs to the end of the paid period, and
nothing of theirs is deleted — folders, waypoints, notes and photographs all
stay, and export keeps working, because getting your own data out is free.
Closing the account is a separate, irreversible thing, and cancelling first
matters or somebody carries on paying for an account that is not there.

---

## What is not built

**The App Store side.** In-app purchase exists only inside a shipped native
app, and there is not one — see `docs/mobile-app.md`. The server half, an
endpoint receiving App Store Server Notifications and writing an `entitlements`
row with `source = 'appstore'`, is deliberately not written yet either: it
could not be exercised until there is an app and a product to exercise it with,
and untested signature verification sitting deployed on a path that grants
entitlements is the exact thing the Stripe tests exist to avoid.

**One person, two subscriptions** — decided, and closed. A checkout is refused
outright for an account that already has a running subscription, with a 409 and
a sentence naming where to cancel: the billing portal for a Stripe one, Apple's
Settings for an App Store one. The alternative was letting the second
subscription overwrite the first, which means two charges a month with one of
them invisible, and cancelling the visible one takes away access the invisible
one is still paying for. Nobody untangles that from the outside.

The refusal is read through the caller's own session rather than with the
service key, so this function cannot become a way to ask about somebody else's
account.

**Server-side enforcement.** Everything in `assets/js/lib/tiers.js` decides what
to *draw*. What actually costs money has to be refused where the bill is — the
row policy for sync, whatever proxy ends up in front of Valhalla for routing,
whoever serves the tiles for downloads — and none of those read a plan yet.
