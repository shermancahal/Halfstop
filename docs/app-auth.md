# Accounts inside the app

Three things stand between the current build and an App Store submission that
can offer accounts. None of them are hard; all three are easy to get subtly
wrong, and two of them cannot be tested from a browser at all.

This is the runbook. Steps are marked **(console)** for work in somebody's
dashboard, **(code)** for work in this repository, and **(Mac)** for work that
needs Xcode in front of you.

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

### In the app — native **(Mac + code)**

Supabase's own guidance: use native Sign in with Apple on Apple platforms
rather than the OAuth flow. It also avoids the maintenance trap below.

1. **(console)** Apple Developer → Identifiers → your **App ID**
   (`com.halfstop.app`) → tick **Sign in with Apple** in Capabilities. Leave
   the server-to-server notification endpoint blank; Supabase does not support
   it.
2. **(console)** Supabase → Authentication → Providers → **Apple** → enable it
   and list `com.halfstop.app` under authorized client IDs.
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

1. **Services ID** (e.g. `com.halfstop.app.web`) in Identifiers.
2. Configure it → **Website URLs**. The domain is *the one the Supabase project
   is hosted on*, which is now `auth.halfstop.app`, and the return URL is
   `https://auth.halfstop.app/auth/v1/callback`.
3. **Key** in the Keys section → tick Sign in with Apple → download the `.p8`.
   **It downloads once.** Note the Key ID, and the Team ID from the top right.
4. Team ID + Key ID + `.p8` generate the client secret; paste it and the
   Services ID into Supabase → Providers → Apple.

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
