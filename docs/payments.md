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

Stripe has moved this more than once, and the current dashboard calls a webhook
an **event destination**. Look for **Workbench → Webhooks → Add destination**;
older accounts and older guides say *Developers → Webhooks → Add endpoint*, and
it is the same thing.

- **Events**: `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`. The newer flow asks for these first, before
  it asks where to send them.
- **Destination type**: an endpoint of your own, rather than Amazon
  EventBridge or Azure Event Grid.
- **URL**: `https://gqemcvuushtfbbbxypvf.supabase.co/functions/v1/stripe-webhook`

Those three and no more. `checkout.session.completed` is deliberately *not*
one of them: a Checkout Session carries no status and no period end, and its id
is the session's rather than the subscription's, so granting from it produced
an entitlement with the wrong reference and no expiry at all. See
`stripe-webhook/events.mjs`. Every other event is answered 200 and ignored, so
subscribing to more only makes the log harder to read.

**The signing secret** is on the destination's own page once it exists, under
**Signing secret**, behind a *Reveal* or *Click to reveal*. It reads
`whsec_...`. That value goes in `STRIPE_WEBHOOK_SECRET` in Supabase, and the
function has to be redeployed afterwards to pick it up.

It belongs to that one destination: create a second, or switch from test mode
to live, and the secret is different. Until it is set, the function answers
every delivery with a 503 saying it has no signing secret, which is the
intended behaviour rather than a fault.

**Check the API version on the destination.** It defaults to the account's
default, which is whatever version the Stripe account was first created under -
on this account, `2015-02-10`. That governs the shape of every event Stripe
sends. The function reads `current_period_end` both where it used to live and
where it lives now, so an old version is survivable, but a decade of drift is
not something to rely on: set the destination to a current version if the
dashboard lets you.

The calls the functions *make* no longer depend on it. They send an explicit
`Stripe-Version` header, because Checkout Sessions did not exist in 2015 and
`mode`, `line_items` and `subscription_data` are all newer than the account
default they would otherwise have inherited. Raising it is a deliberate edit in
`stripe-checkout/index.ts` and `stripe-portal/index.ts`, not a dashboard
setting somebody flips.

### 4b. Name yourself as a tester

Supabase → Edge Functions → Secrets:

| Name | Value |
| --- | --- |
| `BILLING_TESTERS` | `you@example.com`, comma separated for more than one |

**This is the control that matters while the keys are test keys.** A test-mode
checkout is a real entitlement bought with a card that is not a card: type
`4242 4242 4242 4242`, no money leaves anybody's account, Premium for good.
Both `stripe-checkout` and `stripe-portal` refuse anybody not on this list
whenever `STRIPE_SECRET_KEY` begins `sk_test_`.

Hiding the button does not do this. The functions are reachable by anybody
holding a session, drawn button or no. Empty means nobody, which is the right
default.

The check disappears by itself when the key becomes a live one, because then a
checkout costs real money and there is nothing to protect against.

### 5. Turn it on, for yourself first

Not by editing `config.js`. Both values are read from injected globals, so
turning them on is a line in `assets/js/token.js`, which is gitignored:

```js
window.ABMAP_BILLING_LIVE = 'true';
window.ABMAP_BILLING_STORE = 'stripe';
```

`npm start`, and the plan panel has the two buttons.

**Testing with a second account.** A subscription bought by the account that
also administers the site proves less than it looks like: that account sees
things nobody else does. To test as an ordinary person, add the other address
to `ABMAP_BILLING_TESTERS`, which is the list of people shown the purchase
panel while billing is off:

```js
window.ABMAP_BILLING_TESTERS = 'you@example.com, other@example.com';
```

Sign in as that address on `npm start` and the panel appears, labelled *Test
mode*. The same address must also be on `BILLING_TESTERS` in the Edge Function
secrets, or pressing the button gets a 403 — and that is the right way round:
this list draws a button, that list decides who may pay. This file is served to
the browser, so it can never be the second thing.

Anybody in `SITE.editors` sees the panel too, without being listed, because
whoever runs Halfstop needs to press the button that everybody else must not
see yet.

**Prefer to do this locally.** The deploy writes the same global into
`assets/js/token.js` from a repository secret of the same name, and that file
is served to every visitor — so an address set there is readable by anybody who
views source. A test account's address on a public page is a small thing and
not nothing. Locally it costs no exposure at all, and the Edge Functions,
Stripe and Supabase are the same ones either way, so the test is just as real.

**Do not commit a live default while the Stripe keys are test keys.** A
Subscribe button on the public site backed by a test-mode key is worse than
useless: anybody can pay with `4242 4242 4242 4242`, have no money leave their
account, and come away with a real entitlement row. Testing belongs on your own
machine until the keys are live ones.

When it is time, launching is two repository **variables** — Settings →
Secrets and variables → Actions → Variables:

| Name | Value |
| --- | --- |
| `ABMAP_BILLING_LIVE` | `true` |
| `ABMAP_BILLING_STORE` | `stripe` |

The deploy writes them into `token.js` the same way it writes the Mapbox and
Supabase values, and the run summary says which state it published. Launching
is then a deploy, not a commit that changes what strangers see. (`ABMAP_BILLING_TESTERS`
is a *secret* rather than a variable, only because it holds real addresses;
it still ends up in a file anybody can read.)

`live` closes the feature gates and `store` is what offers a way to buy. They
are separate on purpose: the gates can be proven with billing live and nothing
for sale.

### 6. Test it before anybody real does

Use the test key and Stripe's test cards — `4242 4242 4242 4242`, any future
expiry, any CVC, any postcode. Nothing is charged and no real card should ever
be typed into a test-mode checkout.

The whole run, end to end:

1. `npm start`, sign in as the test address.
2. Account menu → the plan panel shows **$4.99 a month** and **$49 a year**,
   under *Test mode*.
3. Press one. The page goes to `checkout.stripe.com` — Stripe's own domain,
   which is the point: no card details touch this app.
4. Pay with the test card. Stripe returns you to where you started.
5. The app says *Finishing off your subscription…* and then *Premium is active
   on this account.* That second message is the webhook having landed; the app
   asks up to eight times over about twelve seconds, because the return trip
   and the webhook are two separate things and the webhook is usually, but not
   always, the faster of the two.
6. The two price buttons are replaced by **Manage subscription**. That is the
   visible proof, and it is the only one: the plan still reads *Free*, because
   with `ABMAP_BILLING_LIVE` off the tier names and the countdown are
   deliberately silent — every feature is open to everybody, and calling an
   account Premium while that is true would be describing a restriction that
   does not exist. Turn `ABMAP_BILLING_LIVE` on locally and the panel names the
   tier and counts the days.

And underneath, in the Supabase SQL editor:

- `select * from public.entitlements where source = 'stripe';` — one row, the
  right `user_id`, `expires_at` a month or a year out.
- `select public.my_plan();` as that user says `premium` with `source: 'stripe'`.
- Press Subscribe again: it should refuse with *You already subscribe*, not
  sell a second one.
- Cancel from **Manage subscription** and watch `expires_at` move to the end of
  the paid period rather than vanishing.

If step 5 ends in *this account has not caught up yet*, the checkout worked and
the webhook did not: Stripe → Developers → Event destinations shows what it
tried to deliver and what came back, and `stripe listen --forward-to <url>`
replays events if something in the middle is not firing.

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

**Cancelling is not a cancellation event.** Stripe keeps the subscription
`active` with `cancel_at_period_end` set, and the only thing that arrives is an
ordinary `customer.subscription.updated` carrying the same status and the same
date as a healthy one. Read from status alone, the entitlement written for a
cancelled subscription is identical to the one written for a renewing
subscription — which is how the app came to tell somebody who had just
cancelled that their plan renewed on the day it actually stopped.

So `entitlements.renews` holds the answer, filled from `cancel_at_period_end`
(and from `cancel_at`, which is how Stripe says the same thing for a
cancellation set to a specific moment). `my_plan()` returns it, and the settings
menu draws either *Renews October 13, 2026* or *Ends October 13, 2026* under the
plan name. A row that predates the column reads as renewing: wrongly promising a
renewal is a smaller wrong than wrongly announcing that somebody's access is
ending.

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

## Before turning `ABMAP_BILLING_LIVE` on

The flag is one repository variable — Settings → Secrets and variables →
Actions → Variables, `ABMAP_BILLING_LIVE = true` — and the next deploy writes
it into the client config. What it does is close every gate in
`assets/js/lib/tiers.js` and put the purchase panel in front of everybody, so
the Stripe keys on the Edge Functions had better be live ones.

Two things to know before flipping it.

**The gates have to be asked with a tier, and for a while they were not.**
`can()` falls back to Free when no tier is passed, and while the flag is off it
never gets that far — it answers true for everything first. So the omission is
completely invisible until the flag flips, at which point every gate closes on
the people who just paid: metered basemaps locked, offline downloads locked,
routing locked, for a Premium account. "Subscribing took my basemaps away" is
the report that would have followed. The viewer now asks through `allowed()`
and `lockedBecause()`, which bind the tier from the account, and a test fails
on any bare `can('…')` left in the app.

**Nothing is enforced on the server yet.** Everything in `tiers.js` decides
what to draw. A reader who opens the console can still call the tileset, the
routing URL and the row policy directly. That is a decision, not an oversight —
see the end of the section above — but it means the flag buys a tidy paywall
and not a real one.

A narrower alternative, if what you want is one account to see the metered
maps: add the address to `SITE.editors` in `assets/js/config.js`. It changes
nothing else and nothing for anybody else.
