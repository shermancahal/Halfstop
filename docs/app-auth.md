# Accounts inside the app

Three things stand between the current build and an App Store submission that
can offer accounts. None of them are hard; all three are easy to get subtly
wrong, and two of them cannot be tested from a browser at all.

This is the runbook. Steps are marked **(console)** for work in somebody's
dashboard, **(code)** for work in this repository, and **(Mac)** for work that
needs Xcode in front of you.

---

## The values this project uses

| | |
| --- | --- |
| Bundle ID / App ID | `com.halfstop.app` |
| URL scheme | `com.halfstop.app://account` |
| Apple Team ID | `PTVA266FXM` |
| Auth callback | `https://auth.halfstop.app/auth/v1/callback` |

The callback is worth reading twice: it is the **custom domain**, not
`gqemcvuushtfbbbxypvf.supabase.co`. Activating the domain changed what Supabase
Auth advertises to every provider, so this is the URL to register with Apple,
and it is the one Google needs too - see the note at the end of section 2.

None of the four is a secret. The Team ID appears in any app-site-association
file, which is served publicly by design. **The `.p8` signing key is a secret**
and never goes in this repository - it is the one file that can mint client
secrets for your Apple account.

---

## Where this stands

**Android: built.** The code half of section 1 is in, for both email links and
Google:

- `npm run app:android` writes the intent filter that opens
  `com.halfstop.app://` links (Step B, Android half) - `withDeepLink` in
  `tools/app.mjs`, run on every build.
- `emailReturn()` answers `com.halfstop.app://account` inside the app
  (Step C).
- `assets/js/lib/native-shell.js` catches the link, both while the app is
  running (`appUrlOpen`) and when the link started it (`getLaunchUrl`) - Step
  D, done differently from the sketch below. Rather than a second
  implementation of the fragment handling with `setSession`, the app
  *navigates* to the page the website would have landed on, fragment and all:
  `account.html#access_token=…`. supabase-js then reads it exactly as it does
  on the website, and the recovery form, the "that link did not work" message
  and the already-used check all come along for free. That is also why
  `PASSWORD_RECOVERY` needs no special case.
- Continue with Google opens in a Chrome Custom Tab through
  `@capacitor/browser` and comes back the same way (Step E).

Tested in `test/native-shell.test.mjs`; the device itself is the part that
cannot be tested from here.

**iOS: the same JavaScript, not yet the native half.** The URL type in
`Info.plist` (Step B, iOS half) and Sign in with Apple (section 2) are still to
do.

**Still yours, in dashboards** - Step A and Google's side, below. Until Step A
is done, every link the app sends silently lands on the website instead.

### Google sign-in, in order

The app signs in with Google through the browser, the same way the website
does, so it needs only a **Web** OAuth client - no Android client and no SHA-1
fingerprint.

1. [Google Cloud console](https://console.cloud.google.com) → pick or create a
   project (the Play billing service account can live in the same one) →
   **Google Auth Platform**, which older guides call the *OAuth consent
   screen*.
2. **Branding.** App name *Halfstop*, a support email, and under App domain:
   home page `https://app.halfstop.app/`, privacy policy
   `https://app.halfstop.app/privacy.html`, terms
   `https://app.halfstop.app/terms.html`. Authorized domain `halfstop.app`.
   Leave the logo off for now: adding one sends the app for brand verification
   before the logo is shown.
3. **Audience.** User type *External*, then **Publish app** so the status reads
   *In production*. In *Testing*, only the listed test users can sign in and
   everybody else is told *Access blocked*. Supabase asks only for `openid`,
   `email` and `profile`, which do not need Google's verification.
4. **Clients** → Create client → **Web application**. Name it
   *Halfstop (Supabase)*. Under Authorized redirect URIs add both:
   ```
   https://auth.halfstop.app/auth/v1/callback
   https://gqemcvuushtfbbbxypvf.supabase.co/auth/v1/callback
   ```
   Create, and copy the Client ID and the Client secret. The secret is shown
   in the console again later if you lose it, but treat it as one.
5. [Supabase → Authentication → Sign In / Providers → Google](https://supabase.com/dashboard/project/gqemcvuushtfbbbxypvf/auth/providers):
   enable, paste the Client ID and secret, save.
6. **Step A.** Supabase → Authentication → URL Configuration → Redirect URLs →
   add `com.halfstop.app://**`. Do not touch Site URL.

Then check it in this order:

- **The website first**, on a computer. Its sign-in panel now shows *Continue
  with Google* by itself - the panel asks Supabase which providers are on. That
  round trip proves steps 1 to 5 without the phone.
- **Then the app.** *Continue with Google* opens a Chrome tab, you pick an
  account, and it comes back into Halfstop signed in, on the page you pressed it
  from. If it lands on app.halfstop.app in Chrome instead, step 6 is missing.
- **Then an email link.** Sign out, *Email me a link*, open the email on the
  phone. It opens the app, not Chrome. A link asked for in the app and opened
  on a computer cannot work - the computer has no app to open - so open it on
  the phone.

Google's own sign-in sheet (Credential Manager, the account picker that slides
up without leaving the app) is the nicer version of this and a later step: it
needs an Android OAuth client with the SHA-1 of every signing key, a native
plugin, and a nonce handed to Supabase. The browser round trip works first and
works everywhere.

---

## Why any of this is needed

Inside the Capacitor shell the web view is not this website. On iOS it loads
from `capacitor://localhost`, and that single fact causes all three problems:

- **An emailed link has nowhere to come back to.** Every link the app sends -
  the signup confirmation, the magic link, the password reset, the email change
  - now points at `https://app.halfstop.app/account.html`. Followed on a phone
  with the app installed, that opens **Safari** and signs somebody in on the
  *website*, while the app they were holding stays signed out.
- **Google refuses to sign in inside an embedded web view**, which is what the
  shell is. It answers `disallowed_useragent`.
- **No `Referer` header is sent**, so a URL-restricted Mapbox token is rejected
  on every tile request and the Byways Topo style simply does not draw.

---

## 1. Bringing auth back into the app

### The address the app answers to

A custom URL scheme, in the shape Supabase documents - `[SCHEME]://[HOST]`,
with the scheme unique across the whole device, which is why a reverse domain
is the convention:

```
com.halfstop.app://account
```

It matches `appId` in `capacitor.config.json`, so there is one name to keep
track of rather than two.

### Step A — the allow list **(console)**

Supabase → **Authentication → URL Configuration → Redirect URLs**, add:

```
com.halfstop.app://**
```

The globstar is deliberate: `*` does not cross a `.` or a `/`, so a plain
single star would not match `com.halfstop.app://account`.

**Do not touch Site URL.** It is what the website falls back to, and pointing
it at a deep link would break every email sent to somebody who does not have
the app.

### Step B — the scheme, in the native project **(code, not Mac)**

`ios/App/App/Info.plist` needs:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleTypeRole</key>
    <string>Editor</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.halfstop.app</string>
    </array>
  </dict>
</array>
```

**This must be scripted, not typed into Xcode.** `ios/` is gitignored and
`npx cap add ios` regenerates it, so anything edited by hand there is lost the
next time somebody starts from a clean checkout - and silently, because the
build still succeeds and only the deep link stops working. The same is true of
the two permission strings in section 5 of `docs/mobile-app.md`.

So: a `tools/app-native.mjs` that patches `Info.plist` after `cap add`, run as
step 2a of `tools/app.mjs`. Until that exists, treat any `ios/` on your Mac as
disposable and expect to redo the edits.

Android is the equivalent `intent-filter` in `AndroidManifest.xml`, with
`android:scheme="com.halfstop.app"`.

### Step C — the app asks for a different return address **(code)**

`emailReturn()` in `assets/js/lib/account.js` currently always returns the web
page. It becomes conditional:

```js
function emailReturn() {
  if (globalThis.Capacitor?.isNativePlatform?.()) return 'com.halfstop.app://account';
  return new URL('account.html', window.location.href).href;
}
```

That one change covers all four emailed links, because they already share this
function.

### Step D — catching the return **(code)**

This is the part with a trap in it. supabase-js reads the URL **when the client
is constructed** - that is what `detectSessionInUrl` does, and it is why the
website works. A deep link does not arrive that way: the app is already running
and the URL comes in as an event. So nothing happens unless it is handled.

```js
import { App } from '@capacitor/app';

App.addListener('appUrlOpen', async ({ url }) => {
  const parsed = new URL(url);
  // Supabase puts tokens in the fragment on the implicit flow and errors in
  // the query. Read both rather than guessing which arrived.
  const params = new URLSearchParams(
    (parsed.hash || '').replace(/^#/, '') || parsed.search.replace(/^\?/, ''),
  );

  const failed = params.get('error_description') || params.get('error');
  if (failed) { /* say so, the way account.js already does */ return; }

  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  if (!access_token || !refresh_token) return;

  await client.auth.setSession({ access_token, refresh_token });
});
```

`setSession` fires `onAuthStateChange`, so everything downstream - the panel,
the recovery form, the plan - already works from there. What it does **not**
fire is `PASSWORD_RECOVERY`, so a reset arriving this way needs the type read
off the link (`params.get('type') === 'recovery'`) and `account.recovering` set
by hand.

### Step E — Google through the system browser **(code)**

An embedded web view is refused, so the round trip has to leave and come back:

```js
const { data } = await client.auth.signInWithOAuth({
  provider,
  options: { redirectTo: 'com.halfstop.app://account', skipBrowserRedirect: true },
});
await Browser.open({ url: data.url });   // @capacitor/browser
```

`skipBrowserRedirect` hands back the URL instead of navigating to it. The
return arrives through the same `appUrlOpen` listener as Step D.

Note this is the one place the app and the website legitimately differ: on the
web, `signInWithOAuth` still uses `returnTo()` and comes back to the page
somebody left, which is right there and wrong here.

### Verifying it

**None of this can be checked from this repository.** It needs iOS, a real
device and Xcode. What can be covered here is the part that is pure - which
address is chosen for which platform, and how a returning URL is parsed - and
that is worth doing, because it is where the silent mistakes live.

On the phone, in this order:

1. Sign up with a new address. The confirmation email opens **the app**, not
   Safari.
2. Sign out, then **Forgot password**. The reset opens the app and shows the
   new-password form.
3. Tap that same link a second time. It must say the link did not work rather
   than failing silently.
4. Continue with Google. It leaves to the system browser and comes back signed
   in.
5. Force-quit and reopen. Still signed in.

### Later: universal links

A custom scheme shows a "Open in Halfstop?" prompt. Universal links do not, and
we can host what they need: an `apple-app-site-association` file at
`https://app.halfstop.app/.well-known/`, served as JSON, over HTTPS, with no
redirect and no file extension. Supabase explicitly does not host this; we
would, out of `dist/`, which GitHub Pages serves fine.

```json
{ "applinks": { "apps": [], "details": [ { "appID": "TEAM_ID.com.halfstop.app", "paths": ["*"] } ] } }
```

Plus the Associated Domains capability (`applinks:app.halfstop.app`) in Xcode.
Worth doing, not worth blocking a launch on.

---

## 2. Sign in with Apple

Required by App Store review as soon as the app offers any other third-party
sign-in, which it does - Google. A common reason for a first submission to be
rejected.

There are two implementations and the app wants the **native** one.

### Where each piece lives

| What | Where |
| --- | --- |
| Team ID | top right of the Apple Developer Console |
| App ID | [Identifiers → App IDs](https://developer.apple.com/account/resources/identifiers/list/bundleId) |
| Services ID (web only) | [Identifiers → Services IDs](https://developer.apple.com/account/resources/identifiers/list/serviceId) |
| Signing key (.p8, web only) | [Keys](https://developer.apple.com/account/resources/authkeys/list) |
| Email sources | [Services](https://developer.apple.com/account/resources/services/list) |
| The provider itself | [Supabase → Authentication → Providers → Apple](https://supabase.com/dashboard/project/gqemcvuushtfbbbxypvf/auth/providers) |

### Enabling it lights up a button on the website too

Worth knowing before you tick anything. `refreshProviders()` asks
`/auth/v1/settings` which providers the project has, and `account-panel.js`
draws a button for every one that answers `true`:

```js
this.providers = PROVIDERS.filter((id) => external[id] === true);
```

So enabling Apple for the *app* will most likely make **Continue with Apple**
appear on the *website*, where there is no OAuth secret behind it yet. Check
the sign-in panel on app.halfstop.app immediately after enabling. If the button
is there, either finish the web configuration below or leave the provider off
until you are ready to do both.

### In the app — native **(Mac + code)**

Supabase's own guidance: use native Sign in with Apple on Apple platforms
rather than the OAuth flow. It also avoids the maintenance trap below, and
their docs are explicit that *"if you're building a native app only, you do not
need to configure the OAuth settings"* - no Services ID, no key, no secret.

1. **(console)** Apple Developer → Identifiers → your **App ID**
   (`com.halfstop.app`) → tick **Sign in with Apple** in Capabilities. Leave
   the server-to-server notification endpoint blank; Supabase does not support
   it.
2. **(console)** Supabase → Authentication → Providers → **Apple** → enable it
   and put `com.halfstop.app` in the **Client IDs** field. That field is the
   whole native configuration; every App ID that will use this project goes in
   it, comma separated.
3. **(code)** Add the Capacitor community Sign in with Apple plugin - check it
   is still maintained before depending on it - and hand the identity token
   straight to Supabase:
   ```js
   const { response } = await SignInWithApple.authorize({ /* … */ });
   await client.auth.signInWithIdToken({ provider: 'apple', token: response.identityToken });
   ```
4. **(Mac)** Xcode → Signing & Capabilities → **+ Capability** → Sign in with
   Apple. Same problem as Step B: this edits the generated project, so it
   belongs in the patch script.

### On the website — the OAuth flow **(console)**

Separate from the above and only needed for the site.

1. **Services ID** - Identifiers → the filter menu at the top right → Services
   IDs → **+**. Name it `com.halfstop.app.web`; it must be a different
   identifier from the App ID, not the same one.
2. Open it → tick **Sign in with Apple** → **Configure**:
   - **Primary App ID:** `com.halfstop.app`
   - **Domains and Subdomains:** `auth.halfstop.app`
   - **Return URLs:** `https://auth.halfstop.app/auth/v1/callback`
3. **Key** - Keys → **+** → tick Sign in with Apple → configure it against the
   primary App ID → **Download**. The `.p8` downloads **once and cannot be
   retrieved again**; losing it means revoking and starting over. Note the Key
   ID on that page.
4. Team ID (`PTVA266FXM`) + Key ID + `.p8` generate the client secret - Supabase
   has a generator on the Apple provider page. Paste the secret and the Services
   ID into Supabase → Providers → Apple, in the OAuth fields **below** the
   Client IDs field the native side already uses. Both halves coexist: Client
   IDs serves the app, the secret serves the website.

### An app account has no password, so the website needs these too

Not a nicety. Somebody who taps Continue with Apple in the app never sets a
password - there is nothing to type on the website, and the email form cannot
help them. Until the web half of both providers is configured, every account
created in the app is an account that cannot sign in at app.halfstop.app.

The buttons themselves are already built and have been all along; they are
drawn for whatever `/auth/v1/settings` reports as enabled, so they appear the
moment the provider is configured and stay hidden while it is not. Nothing in
this repository needs changing for them.

### Register the sending domain with Apple, or relay mail bounces

Easy to miss because it sits in a different section of the console from
everything else. Apple's **Sign in with Apple for Email Communication**
([Services](https://developer.apple.com/account/resources/services/list)) is
where you list the domains allowed to send to a private relay address.

It matters here because of Hide My Email: somebody who chooses it gets an
account whose address is `…@privaterelay.appleid.com`, and everything this app
sends them - the password-changed notice, a reset link, a folder invitation -
goes through Apple's relay. Mail from a domain that is not registered there is
dropped rather than forwarded.

#### Register two domains, not one

The obvious answer is `send.halfstop.app`, the domain the mail is *from*. That
is half of it.

Apple's check is on the **envelope sender** - the `MAIL FROM` / `Return-Path`,
not the `From:` header - and Apple's own help is specific that "the registered
domain and envelope sender domain must match exactly to pass the SPF check".
Resend does not use the From domain as the envelope domain. Its custom
return-path feature puts the bounce address on `send.<domain>`, which for a
sending domain of `send.halfstop.app` makes the envelope domain
`send.send.halfstop.app`. The doubled word is not a typo.

The DNS says the same thing. As it stands:

| Name | TXT |
| --- | --- |
| `send.halfstop.app` | `v=spf1 +a +mx include:halfstop.app.spf.auto.dnssmarthost.net ~all` |
| `send.send.halfstop.app` | `v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all` |
| `rsend.send.halfstop.app` | `v=spf1 include:amazonses.com ~all` |

The record carrying the actual sending IPs is on `send.send.halfstop.app`. The
one on `send.halfstop.app` is the web host's default, inherited from the parent
domain, and names no Resend address at all - mail passes today on DKIM
alignment and on the envelope domain's own SPF, not on that record.

So register both, comma-delimited, in one go:

```
send.halfstop.app, send.send.halfstop.app
```

Registering both costs nothing - an individual account may register 32 email
sources and an organization 100 - and it removes the need to be right about
which one Apple keys off. If the table still reports a failure, the third
candidate is `rsend.send.halfstop.app`, Resend's other delegated path.

There is no file to upload. Apple reads DNS, and the Email Sources table shows
a pass or fail per row.

#### While you are in there

Worth noticing, not worth fixing blind: `send.halfstop.app` publishing the web
host's SPF record is misleading. It authorizes the hosting provider's mail
servers to send as the domain Halfstop sends from, and it authorizes none of
Resend's. Nothing is broken by it - DMARC on `halfstop.app` is `p=none` with
relaxed alignment, and DKIM aligns - but an SPF record that describes the wrong
sender is a trap for whoever reads it next. Changing it means knowing what else
sends as that domain, which is a separate job from this one.

### Google needs the same URL, and nobody has checked

Activating the custom domain changed the callback Supabase advertises for
**every** provider, not just Apple. If the OAuth client in Google Cloud Console
still lists only `https://gqemcvuushtfbbbxypvf.supabase.co/auth/v1/callback`,
then Continue with Google is broken on the live site right now and will fail
with `redirect_uri_mismatch`.

Nothing has surfaced it because the auth log shows no provider sign-in attempts
since the domain went live - so it would stay quiet until a real person tried.
Add `https://auth.halfstop.app/auth/v1/callback` to the client's authorized
redirect URIs **alongside** the old one, rather than replacing it.

### The thing that will break in six months

Apple's OAuth client secret **expires**, and Supabase's docs are blunt about
it: a new secret must be generated from the `.p8` every six months, and
missing it *"will cause authentication failures"*. Put a recurring reminder
next to wherever the `.p8` is stored.

Native-only implementations do not have this problem. That is a second reason
the app should use the native path even after the web one exists.

---

## 3. The app's Mapbox token

The smallest of the three and already wired: `tools/build-dist.mjs --app` reads
`ABMAP_MAPBOX_TOKEN_APP` and **refuses to build** rather than falling back to
the website's token, because shipping a URL-restricted token into a web view
that sends no `Referer` produces a map that is simply blank.

1. **(console)** Mapbox → Access tokens → create a token:
   - **No URL restriction.** This is the whole point.
   - Scopes: `Styles:Tiles`, `Styles:Read`, `Fonts:Read`. Nothing else.
   - Set a usage limit on it before you ship.
2. **(code)** Add it to `assets/js/token.js`, which is gitignored, beside the
   website's:
   ```js
   window.ABMAP_MAPBOX_TOKEN     = 'pk.…';   // the website, URL-restricted
   window.ABMAP_MAPBOX_TOKEN_APP = 'pk.…';   // the app, unrestricted
   ```

Two tokens rather than one because an IPA is a zip and anyone can pull strings
out of one. A leak from the binary is then one revocation, not two.

---

## The order to do them in

1. **#3 first.** Five minutes, unblocks everything else - without it the map is
   blank in the shell and you cannot tell a broken build from a broken token.
2. **The patch script.** Steps B and 2.4 both edit a generated project, and
   doing them by hand twice is how you learn to script it.
3. **#1.** The biggest piece, and the one that decides whether accounts are
   usable in the app at all.
4. **#2 native.** Needed for review, not for testing.
5. **#2 web**, whenever. The site works without it.

## Whose folders are on this device

The folder store is one working set per browser — that is what makes folders
usable before anybody signs in — and it used to carry no record of whose it
was. Sync pushes whatever is local to whoever is signed in, so signing in as a
second account on a browser that still held the first account's folders wrote
the whole collection to the server under the new user id.

That happened here on 2026-09-13: 27 folders, 8,765 items, the same client ids
under both accounts. Nothing leaked between people — both accounts were the
same person — but the shape of it is one person's places becoming rows on
another person's account, which on a shared browser is exactly what it sounds
like.

Signing out already clears the folders once they are safely on the server, so
the intended state when switching accounts is an empty store. The guard is for
every way that does not happen: a sign-out whose sync failed, a session that
simply expired, a second account signed in beside the first.

`ab-maps-folder-owner-v1` in localStorage holds the user id the folders were
last synced with, written only *after* a push succeeded. On the next sync:

| stamp | what happens |
| --- | --- |
| this account | the ordinary two-way sync |
| none | adopted and stamped — the sign-up case, and every device older than the guard |
| another account | nothing local goes up; this account's own folders replace it, and the panel says so |

Replace is safe because of when the stamp is written: a set stamped to another
account is a set that account already holds on the server, so dropping it here
loses nothing. An unstamped set is deliberately not treated that way — nothing
says it was ever uploaded, and discarding folders somebody made offline to fix
a bug about folders is the same mistake pointing the other way.

**Cleaning up a collection that already crossed** takes the guard first. The
copies carry the same client ids as the originals, so tombstoning them on the
wrong account, on a device that has not yet been stamped, would send those
tombstones on to the account that owns the originals and delete them. With the
guard in place that cannot happen: the device is stamped to the account it
synced with, and the other account's sign-in replaces rather than pushes.
