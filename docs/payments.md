# Taking money: what has to be set outside this repository

What has to be set in dashboards for Halfstop to take money: Stripe for the
website, Google Play for the Android app. Both switches (`ABMAP_BILLING_LIVE`,
`ABMAP_BILLING_STORE`) are read from injected globals rather than committed, so
a checkout never goes live because somebody pushed a file.

Several providers, one row. `public.entitlements` has a `source` column for
exactly this reason: a store can only sell inside its own app, and anybody
using Halfstop in a browser has no way to pay through one. Stripe is that way,
and both stores permit it — a subscription bought elsewhere may be honoured in
the app, as long as the app does not send people out to buy it and does not
advertise the outside price. Google Play is the Android app's way; see
[Google Play](#google-play-for-the-android-app) below.

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
`whsec_...`. That value goes in `STRIPE_WEBHOOK_SECRET` in Supabase. No redeploy: a
secret set in the dashboard is available to every function immediately, which
is what `docs/auth-setup.md` says two pages over and what this line used to
contradict.

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

## VAT, and selling into the EU

A digital subscription sold to somebody in the EU is taxed where *they* are,
not where you are, and from the first euro. The threshold that lets small
sellers off is for businesses established in the EU; a US company does not get
it. There are two halves to this and Stripe only does the second one.

**Registering** is yours. The **non-Union OSS** scheme lets a non-EU seller
register in one member state and file a single quarterly return covering all
of them; the alternative is registering country by country. Stripe Tax
calculates and collects — it does not file your return.

**Collecting** is Stripe Tax: Dashboard → **Tax**, set the origin address, and
add each registration under **Tax → Registrations**. Two settings on the
product are easy to miss and both bite:

- **`tax_behavior` on every price.** Stripe refuses a Checkout Session whose
  price does not have one, so an unset price is not a slightly wrong tax, it is
  a checkout that 502s. It is also immutable once set: changing inclusive to
  exclusive means new prices and new ids in the secrets. Inclusive is the EU
  consumer convention — the listed price is what they pay — and exclusive puts
  up to 27% on top at the last screen, which reads as a bait and switch.
- **A tax code on the product**, rather than the account default. A digital
  services or SaaS code is the one to look for.

### The switch, in Supabase

| Name | Value |
| --- | --- |
| `STRIPE_AUTOMATIC_TAX` | `true` |

Unset is off, and off is the default on purpose. Stripe Tax being on in the
dashboard does nothing to a Checkout Session that does not ask for it, and a
Session that asks for it before the prices have a `tax_behavior` fails
outright — so this switch is the window between the code shipping and the
dashboard being finished, held open. Flip it when the dashboard side is done;
it needs no deploy.

It turns on three things at once, and they are one setting with three names —
see `stripe-checkout/tax.mjs`:

- `automatic_tax` is the calculation.
- `billing_address_collection: required` is what the calculation runs on.
  Stripe has to place somebody in a country to know the rate, and for a
  digital service that address is the evidence they were placed correctly.
  `auto` asks for an address only when the payment method insists, which for a
  card is often never.
- `tax_id_collection` is the business case. An EU company that cannot type its
  VAT number is charged VAT it then has to reclaim, where the reverse charge
  would have meant not charging it.

On a subscription Session these carry through to the subscription Stripe
creates, so a renewal is taxed on the same footing as the first payment rather
than quietly going out untaxed a month later.

### What Stripe does not cover

**Payment methods** need no code. Nothing pins `payment_method_types`, so
whatever is enabled under Settings → Payment methods appears by itself — SEPA
Direct Debit is the one that matters for EU recurring, with iDEAL and
Bancontact able to set up a SEPA mandate. SCA and 3D Secure are handled by
Checkout with nothing to configure.

**The 14-day right of withdrawal** is not a Stripe setting and is not written
anywhere in this repository yet. An EU consumer buying at a distance has one;
digital services are exempt, but only where the customer expressly consents to
immediate performance *and* acknowledges losing the right. That is wording in
`terms.html`, and it is not there.

---

## Google Play, for the Android app

Google requires Play Billing for a digital subscription sold in an Android app,
the way Apple requires in-app purchase, so the Android app sells through Play
and through nothing else. That is decided by where the page is running, not by
a setting: `purchaseRoute` in `assets/js/lib/tiers.js` answers `play` inside the
Android app whatever `ABMAP_BILLING_STORE` says.

### How it fits together

1. **The phone buys.** `assets/js/lib/play-billing.js` asks Play for the
   offers, checks the base plan the button names really exists (the plugin
   otherwise falls back to whichever plan it finds first), and buys it with
   the signed-in account's id attached as the purchase's *obfuscated account
   id*. It does not acknowledge the purchase.
2. **The server asks Google.** The app sends only the purchase token to the
   `play-billing` function. The function asks Google's Android Publisher API,
   as a service account, what that token is: which product, for which account,
   in which state, until when. It writes the `entitlements` row with source
   `play`, and only then acknowledges the purchase. Google refunds anything not
   acknowledged within three days, so a purchase this project failed to record
   is returned without anybody having to notice.
3. **Google keeps it current.** Real-time developer notifications arrive
   through Pub/Sub at `play-billing/notify` - renewed, cancelled, in grace, on
   hold, refunded, expired - and each one makes the function ask Google again.
   Nothing in a notification is believed except which token to ask about.

The rules about what gets written are in `supabase/functions/play-billing/decide.mjs`
and tested in `test/play-server.test.mjs`: a token presented by an account
other than the one it was bought for is refused; a running Stripe subscription
is never written over (the Play purchase is left unacknowledged and Google
refunds it); an old subscription's expiry cannot end the one that replaced it
when somebody switches between monthly and yearly; `CANCELED` in Google's
vocabulary means runs to the end of the period, not revoked.

**Already done:** the `play-billing` function is deployed, and the database
accepts `play` as a source. Everything below is in Google's consoles and
Supabase's.

### 1. Play Console: a build on a testing track

Play will not sell a subscription in an app it has never seen - and it will
not even let you *create* one until it has seen a build that contains the
billing library. So this build has to come from after `npm run app:android`
with the plugins installed (`docs/mobile-app.md` section 6c); an older one
has no billing in it, and Play Console says the app has no in-app products
support.

**Make the upload key** - in a terminal, not in Android Studio's *New Key
Store* dialog. The dialog failed twice on the first run here and said only
*Failed to create keystore*; `keytool` is the same tool underneath, it ships
inside Android Studio, and it says what went wrong.

```sh
mkdir -p ~/Documents/Claude/Keys
"/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" -genkeypair -v \
  -keystore ~/Documents/Claude/Keys/halfstop-upload.jks \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Your Name, O=Halfstop LLC, L=Indianapolis, ST=Indiana, C=US"
```

- It asks for a password twice, and shows nothing while you type. At least
  six characters; if it asks for a separate key password, press Return to
  reuse the same one.
- Keep the key **outside every clone**. Not in `android/` either: that folder
  is gitignored and regenerated, and `rm -rf android` is a step these docs give
  for fixing Gradle trouble. `.gitignore` also ignores `*.jks` as a net, but
  the rule is the folder.
- If Documents is synced by iCloud, the key is backed up there, which is
  fine. Keep a second copy of the file and its password in a password manager
  as well. Losing it is recoverable - with Play App Signing, Google can
  register a new upload key - but it takes a support request and days.

**Make the file** - in Android Studio, with the project `npm run app:android`
opened:

1. **Build → Generate Signed App Bundle or APK…** → **Android App Bundle** →
   Next.
2. Module `app`. **Choose existing…** and pick the `.jks` file. Key store
   password as set, alias `upload`, key password the same.
3. Next → build variant **release** → **Create**. The file lands at
   `android/app/release/app-release.aab`; the notification that says it
   finished has a *locate* link.

The version is `versionCode 1` in `android/app/build.gradle`. Play refuses a
second upload with the same number, so each later upload needs it raised by
one first.

**Upload it** - [Play Console](https://play.google.com/console):

1. **Create app** if Halfstop is not listed yet: name *Halfstop*, *App*, and
   **Free** - the download is free and the subscription is sold inside it.
   Paid-to-download cannot be undone later. Accept the two declarations.
2. The app → **Test and release → Testing → Internal testing** → **Testers**
   tab: create an email list with your own Google account on it, save, and
   copy the **opt-in link**.
3. **Releases** tab → **Create new release**. If asked about app signing,
   choose **Use Google-generated key** (Play App Signing) - Google keeps the
   key that signs what users download, and yours is only for uploading.
4. Drop `app-release.aab` in, give the release a name (`1.0 (1)` is fine),
   **Next**, then **Save and publish** / **Start rollout to Internal
   testing**. If Play lists setup items it wants first, the app's Dashboard
   says which.
5. On the phone, open the opt-in link, accept, and install Halfstop from the
   Play Store link it shows.

The first upload also fixes the app's package name in Play for good. It comes
from `appId` in `capacitor.config.json`, `com.halfstop.app`.

After that, a build run from Android Studio with the same package name can
usually buy with a licence-tester account. If Play says the item is
unavailable, install the app from the internal testing link instead.

### 2. The subscription

Monetize with Play → Products → **Subscriptions** → Create subscription.

| Field | Value |
| --- | --- |
| Product ID | `premium` - exactly, and it can never be reused |
| Name | Halfstop Premium |

Then two **base plans** on that one subscription, each auto-renewing:

| Base plan ID | Billing period | Price |
| --- | --- | --- |
| `monthly` | 1 month | $4.99 |
| `yearly` | 1 year | $49.00 |

Set the US price and let Play fill in the other countries; it rounds each to a
local price point, and the app's buttons show Play's price for the reader's
country rather than ours. **Activate** both plans - a base plan in draft is one
the app is told does not exist. The ids are the ones in `BILLING.play` in
`assets/js/config.js`; if you pick different ones, change them there too.

Two things that differ from Stripe. Google is the merchant of record for Play
sales, so it works out and collects sales tax and VAT itself - there is no
equivalent of the Stripe Tax setup. And Google keeps a service fee, 15% on
subscriptions.

### 3. Licence testers

Play Console → Settings → **License testing**: add the Google accounts you will
test with (your own, at least), licence response *RESPOND_NORMALLY*. Add the
same accounts to the internal testing track's testers and accept the opt-in
link on the phone.

A licence tester's purchase is charged to a test card ("Test card, always
approves") and costs nothing. Test subscriptions renew fast - a monthly plan
every five minutes - and stop after six renewals.

That speed matters for the order you do this in: every renewal arrives as a
notification (step 6), and without notifications the row written at purchase
simply runs out five minutes later. Set up step 6 before testing, or a working
purchase looks like one that expired.

### 4. Google Cloud: the API and a service account

The function asks Google as a *service account* - a robot user with a key.

1. [Google Cloud console](https://console.cloud.google.com) → pick a project
   (the one with the Google sign-in client is fine) or create one.
2. APIs & Services → Library → **Google Play Android Developer API** → Enable.
3. IAM & Admin → **Service accounts** → Create service account. Name it
   `play-billing`. It needs no roles in the Cloud project; skip that step.
4. Open it → **Keys** → Add key → Create new key → **JSON**. A file downloads.
   It is a secret: it goes into Supabase in step 5 and nowhere else, and the
   download should be deleted once it is there.
5. Back in Play Console → **Users and permissions** → Invite new users → the
   service account's email (it ends `iam.gserviceaccount.com`) → App
   permissions → add Halfstop, and tick:
   - *View financial data, orders, and cancellation survey responses*
   - *Manage orders and subscriptions*

   Invite. Google can take a while - hours, occasionally a day - to let the new
   account use the API. Until it does, the function's log says *insufficient
   permissions*, which is this and not a bug.

### 5. The secrets, in Supabase

Edge Functions → Secrets:

| Name | Value |
| --- | --- |
| `PLAY_SERVICE_ACCOUNT` | the whole content of the JSON file from step 4 |
| `PLAY_NOTIFY_TOKEN` | a long random string: `openssl rand -hex 32` in a terminal |

`PLAY_SERVICE_ACCOUNT` is pasted as the whole file, braces and all. If the
dashboard field mangles it, paste it base64-encoded instead
(`base64 -i key.json` on a Mac) - the function reads either. Until it is set
the function answers the app with *Google Play payments are not configured on
this project yet*.

### 6. Real-time developer notifications

In the Google Cloud console, same project:

1. Pub/Sub → **Topics** → Create topic. ID `play-billing`; untick *Add a
   default subscription*.
2. Open the topic → **Permissions** (the info panel) → Add principal
   `google-play-developer-notifications@system.gserviceaccount.com`, role
   **Pub/Sub Publisher**. That is Google Play's own account, and without it
   Play Console refuses the topic.
3. Pub/Sub → **Subscriptions** → Create subscription. ID `play-billing-push`,
   the topic above, delivery type **Push**, endpoint:

   ```
   https://gqemcvuushtfbbbxypvf.supabase.co/functions/v1/play-billing/notify?token=PASTE_PLAY_NOTIFY_TOKEN_HERE
   ```

   with the value of `PLAY_NOTIFY_TOKEN` in place of the capitals. Leave
   *Enable authentication* off; the token is the check. Retry policy:
   exponential backoff.
4. Play Console → Monetize with Play → **Monetization setup** → Real-time
   developer notifications: topic name `projects/YOUR-PROJECT-ID/topics/play-billing`
   (the project id is on the Cloud console's dashboard), and choose to be
   notified about subscriptions and voided purchases. Save, then **Send test
   notification**.
5. Supabase → Edge Functions → `play-billing` → Logs should say
   `test notification from Play Console received`. A 401 there means the token
   in the push URL does not match the secret.

The token in that URL is a secret like the others, but a weak one on purpose:
anybody holding it can make the function ask Google about a purchase token,
and nothing more. What a purchase grants is always Google's answer.

### 7. Buy something

1. On the Mac, re-run the install line in `docs/mobile-app.md` section 6c (it
   now includes the billing plugin), then `npm run app:android`.
2. The purchase panel appears when `ABMAP_BILLING_LIVE = 'true'` is in your
   local `token.js`, or without it for an address in `SITE.editors`, labelled
   *Test mode*.
3. On a phone (or an emulator with the **Play Store** in it, signed in) using a
   licence-tester Google account: sign in to Halfstop, open Account. The two
   buttons carry Play's prices. Press one; Google's sheet appears with the test
   card.
4. *Premium is active on this account.* Then, in the SQL editor:

   ```sql
   select source, expires_at, renews, note from public.entitlements where source = 'play';
   ```

   One row, note *Google Play active, monthly, test purchase*, and an
   `expires_at` that moves forward every five minutes as the test renewals
   arrive.
5. Cancel it in the Play Store (profile picture → Payments and subscriptions).
   Within a minute the notification lands, `renews` turns false and the app
   says *Ends* rather than *Renews*.

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

**An App Store or Google Play subscription cannot be cancelled from here**,
and the function says so rather than failing. Only Apple or Google can end
one. For Play, **Manage subscription** is a link straight to the Play Store's
subscriptions screen, named down to Halfstop's product.

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

**The App Store side.** StoreKit is not built into the iPhone app, and the
server half, an endpoint receiving App Store Server Notifications and writing an
`entitlements` row with `source = 'appstore'`, is deliberately not written yet
either: it could not be exercised until there is a product to exercise it with,
and untested signature verification sitting deployed on a path that grants
entitlements is the exact thing the Stripe tests exist to avoid.

Google Play did not have that problem, which is why it went first. Nothing
Google sends is trusted on its signature: every notification only names a
purchase token, and the function asks Google's API about it directly, with
its own credentials. A forged notification can at most make it ask.

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
