# Shipping this as an iOS and Android app

The plan is Capacitor: it wraps the site — the same `dist/` a web deploy
publishes — in a native shell, and gives it a native project you can sign and
submit. No rewrite, one codebase, and the web version keeps shipping the way it
does now.

What follows is the whole path in order. Nothing here is committed as a native
project yet; steps 3 and 4 create those directories on your machine, and they
are large, mostly generated, and best kept out of this repository until you have
a build you want to keep.

---

## What already landed

The web app is now an installable PWA, which is both useful on its own and a
prerequisite for the Capacitor shell being any good:

| File | What it does |
| --- | --- |
| `manifest.webmanifest` | Name, colours, icons, `display: standalone`. Android and desktop Chrome read this to offer "Install". |
| `sw.js` | Service worker. Precaches the whole 900 KB site so the app shell opens with no network. |
| `assets/js/lib/pwa.js` | Registers the worker, and handles handing over to a newer one. |
| `assets/img/icon-*.png` | Generated from `assets/img/mark.svg` by `tools/build-app-icons.mjs`. |
| `--safe-*` in `site.css` | Keeps the header out from under the iOS status bar when running installed. |

You can try it now: open the site on an Android phone and Chrome offers "Add to
Home Screen"; on iOS use Share → Add to Home Screen. It opens without browser
chrome and works offline.

**One caveat worth stating plainly:** offline here means the *app*, not the
*map*. Basemap tiles belong to Mapbox, USGS, Esri and NOAA; the service worker
passes every cross-origin request straight through and caches none of it, which
is both correct under their terms and the only way to keep the cache bounded.
Offline map coverage is the separate, deliberate thing in
`assets/js/lib/offline.js` — the tiered download and the saved snapshot.

---

## 1. Decide the token first

A Capacitor webview loads from `capacitor://localhost` on iOS and
`https://localhost` on Android, and sends **no `Referer` header**. A Mapbox
token with a URL restriction is rejected on every request from inside the app.

So: **a second `pk.` token, no URL restriction**, scoped to `Styles:Tiles`,
`Styles:Read`, `Fonts:Read`. Keep the website's token URL-restricted and
separate — an IPA or an APK is a zip, anyone can pull strings out of one, and
two tokens means a leak from the binary is one revocation instead of two. Set a
usage limit on it in the Mapbox dashboard before you ship.

Put it in `assets/js/token.js` — which is gitignored, so it never reaches the
repository — beside the website's:

```js
window.ABMAP_MAPBOX_TOKEN     = 'pk.…';   // the website, URL-restricted
window.ABMAP_MAPBOX_TOKEN_APP = 'pk.…';   // the app, unrestricted
```

`npm run dist` ships the first and ignores the second. `npm run dist:app`
ships the second **in place of** the first, so an app bundle never carries the
website's key. It refuses to run rather than falling back: building the app
with the website's URL-restricted token would 401 on every tile with a blank
map and nothing to go on, and that is not a thing to guess at.

Never an `sk.` token. If you later use Mapbox's native SDK for offline packs,
its `DOWNLOADS:READ` secret token is a **build-time** credential: it belongs in
`~/.netrc` on the build machine or in a CI secret, never in the repository,
never in `token.js`, and never in a shipped bundle.

## 2. Install the tooling

Capacitor is intentionally not in `package.json`. `npm test` runs with nothing
installed and that is worth keeping; these are only needed on a machine that
builds the native app.

```sh
npm install --save-dev @capacitor/cli @capacitor/core @capacitor/assets
npm install --save-dev @capacitor/ios @capacitor/android
```

You also need, per platform:

- **iOS** — a Mac, Xcode, and an Apple Developer account ($99/yr). There is no
  way around the Mac for submission.
- **Android** — Android Studio and a Google Play developer account ($25 once).

## 3. Create the native projects

`capacitor.config.json` is already in the repository root and points `webDir`
at `dist`, so build the site first — Capacitor copies whatever is there.

```sh
npm run dist:app      # writes dist/ with the APP token — not `npm run dist`
npx cap add ios
npx cap add android
```

`dist:app`, every time you build for the shell. `npm run dist` puts the
website's token in `dist/`, and `cap sync` would copy it straight into the
bundle.

That creates `ios/` and `android/`. Add both to `.gitignore` until you have a
signing setup worth committing.

## 4. Icons and splash screens

`assets/img/icon-1024.png` is the master. Capacitor's asset generator slices
every native size from it:

```sh
mkdir -p assets-src
cp assets/img/icon-1024.png assets-src/icon.png
npx @capacitor/assets generate --iconBackgroundColor '#b4441f' --splashBackgroundColor '#faf7f2'
```

Regenerate `assets/img/icon-1024.png` with `node tools/build-app-icons.mjs`
whenever `mark.svg` changes; `npm test` fails if the committed icons and the
mark have drifted apart.

## 5. Permissions

The app uses the web Geolocation API, which works in both webviews — but only
if the native project declares why.

**iOS** — `ios/App/App/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Shows where you are on the map and centres it on your position.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>Saves a map snapshot to your photo library.</string>
```

**Android** — `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.INTERNET" />
```

On Android 6+ the runtime prompt is handled by the webview for the web API. If
it proves unreliable, `@capacitor/geolocation` wraps the native API and the call
site in `viewer.js` is one function.

## 6. Build and run

```sh
npm run dist:app && npx cap sync   # rebuild with the app token, copy into both projects
npx cap open ios                   # Xcode
npx cap open android               # Android Studio
```

`cap sync` is the step people forget. Editing files in `assets/` changes nothing
in the app until `npm run dist:app && npx cap sync` has run — the native project
holds a *copy*.

## 7. Things that behave differently inside the shell

- **Service workers do not run on iOS** under the `capacitor://` scheme. That is
  fine: every asset is already local, so the worker had nothing to do there.
  Android uses `https://localhost` and the worker runs normally.
- **No `Referer`**, hence step 1.
- **`localStorage` and IndexedDB persist**, so saved folders, pins, photos and
  offline packs survive between launches — but iOS can evict them under storage
  pressure for a webview app. Anything the user would be upset to lose should be
  exportable, which the GPX export already covers.
- **The build stamp check still runs.** `build.json` is fetched from the bundle
  rather than a server, so it always matches and the reload prompt never fires.
  Harmless, and worth remembering if you wonder why it is quiet.
- **App Store review** wants a privacy policy URL and an accurate answer on data
  collection. The app collects nothing; location never leaves the device except
  as tiles requested around it.

## 8. Updating a shipped app

Two routes, and they are not equivalent:

- **Store release** — rebuild, `cap sync`, bump the version, resubmit. Days for
  iOS review.
- **Capacitor Live Updates / Appflow** — pushes a new web bundle to installed
  apps without review. Allowed by both stores for what is genuinely a web asset
  update, not for changing what the app does. Worth it if the map layers change
  often; not worth it for a few releases a year.

---

## Rough cost and effort

| | |
| --- | --- |
| Apple Developer | $99/yr |
| Google Play | $25 once |
| A Mac | required for iOS, no way around it |
| First build to running-on-a-device | an afternoon |
| First build to *in both stores* | a week or two, most of it review and store listings |
