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

Supabase Dashboard → **Edge Functions → Secrets**:

| Name | Where it comes from |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys. `sk_test_...` first. |
| `STRIPE_PRICE_ID_MONTH` | the monthly price id from step 1 |
| `STRIPE_PRICE_ID_YEAR` | the yearly price id from step 1 |
| `STRIPE_WEBHOOK_SECRET` | step 4, so do that before expecting this to work |

Paste carefully. A trailing newline in a dashboard field is invisible there and
a different string everywhere else; it cost a round of debugging on the support
webhook, which is why every function here trims what it reads.

### 3. Deploy the two functions

```sh
supabase functions deploy stripe-checkout
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

## What is not built

**The App Store side.** In-app purchase exists only inside a shipped native
app, and there is not one — see `docs/mobile-app.md`. The server half, an
endpoint receiving App Store Server Notifications and writing an `entitlements`
row with `source = 'appstore'`, is deliberately not written yet either: it
could not be exercised until there is an app and a product to exercise it with,
and untested signature verification sitting deployed on a path that grants
entitlements is the exact thing the Stripe tests exist to avoid.

**One person, two subscriptions.** `entitlements` is one row per account, so
somebody who subscribes on iOS *and* on the web ends up with the second
overwriting the first: paying twice, with one of them invisible. The
cancellation path is already safe — a Stripe cancellation only touches a row
whose source is `stripe` — but the create path is not. Fixing it needs a
decision rather than a guess: refuse the second purchase, keep whichever
expires later, or allow both and show it. Worth settling before both stores are
live.

**Server-side enforcement.** Everything in `assets/js/lib/tiers.js` decides what
to *draw*. What actually costs money has to be refused where the bill is — the
row policy for sync, whatever proxy ends up in front of Valhalla for routing,
whoever serves the tiles for downloads — and none of those read a plan yet.
