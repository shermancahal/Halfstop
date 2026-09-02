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

## 6a. The first run on a real iPhone

The shortest path from this repository to the map running on a phone in your
hand. Everything above still applies; this is the order to do it in, and what
to look at once it is running.

### Before touching the Mac

1. **Decide the bundle identifier now.** `capacitor.config.json` says
   `com.americanbyways.gps`. It is the app's permanent name to Apple: once a
   build with it reaches App Store Connect, changing it means a different app
   with no update path from the old one. It is free to change today and only
   today. If the product is Fieldstop, `com.americanbyways.fieldstop` is the
   obvious answer; if you keep `gps`, keep it on purpose.

2. **Fill in `assets/js/token.js` completely.** `npm run dist:app` reads that
   file from disk — it does not see the repository variables the website deploy
   uses — and ships whatever is in it. The build now prints what the bundle
   will and will not have; a line reading `accounts & sync OFF` or `MAPBOX
   TILES (billed)` means a value is missing. All six:

   | | |
   | --- | --- |
   | `ABMAP_MAPBOX_TOKEN` | the website's token, as before |
   | `ABMAP_MAPBOX_TOKEN_APP` | the second, unrestricted token — §1 |
   | `ABMAP_SUPABASE_URL`, `_KEY` | from Supabase → Settings → API; the *publishable* key |
   | `ABMAP_PROTOMAPS_ARCHIVE` | the archive URL — the `PROTOMAPS_ARCHIVE` repository variable |
   | `ABMAP_PROTOMAPS_MAXZOOM` | what *Check a map archive* reports; `14` for the current cut |
   | `ABMAP_ROUTING_URL` | leave empty |

### On the Mac

```sh
npm install --save-dev @capacitor/cli @capacitor/core @capacitor/ios
npm run app:ios
```

`app:ios` builds `dist/` with the app token, creates `ios/` the first time,
copies the bundle in, and opens Xcode. It refuses early and by name if
something is missing rather than failing three steps in. Run it again after
any change under `assets/` — the native project holds a copy.

The first time only, add the two permission strings from §5 to
`ios/App/App/Info.plist`. Without the location one, iOS silently denies
geolocation and the locate button does nothing.

### In Xcode

- **Signing & Capabilities → Team.** A **personal team** (a free Apple ID) is
  enough to run on your own phone by cable. The app expires after seven days
  and has to be reinstalled, and nobody else can install it — which is fine for
  a first look. **TestFlight**, and anyone else's phone, needs the paid
  developer account.
- Plug the phone in, pick it as the run target, press Run. The first time, the
  phone asks you to trust the developer under Settings → General → VPN &
  Device Management.

### What to actually test, in this order

Each of these exercises something that only a real device can prove, and each
was reasoned about rather than measured until now.

1. **The map draws.** Byways Topo, at street zoom. Blank tiles with a 401 in
   the Xcode console means the *website's* token shipped — you ran `dist`
   instead of `dist:app`, or `ABMAP_MAPBOX_TOKEN_APP` is empty.
2. **Search finds a place.** That is Mapbox geocoding through the app token.
3. **Locate works** and the map centres on you. If the prompt never appears,
   the `Info.plist` string is missing.
4. **Tap the map, open Photography → Fog.** That is a cross-origin request to
   `api.weather.gov` from `capacitor://localhost`. It *should* pass — NWS sends
   `Access-Control-Allow-Origin: *` — but "should" has not been tested from a
   webview and this is the moment to find out.
5. **Draw a road route on a trip.** Same question, for the router.
6. **Sign in, save a pin, kill the app, reopen.** Persistence in the webview.
7. **Airplane mode, reopen the app.** The shell should open — every asset is
   local — and the panel should build. The basemap will be blank unless a
   region was downloaded first, which is correct.
8. **Rotate, and check the header sits below the notch.** The `--safe-*`
   insets in `site.css`.

Anything in 4 or 5 that fails is a CORS finding worth bringing back here with
the exact console line — it is the one class of problem this repository cannot
reproduce.

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

---

## 9. Drawing the map natively, and what it would actually take

Mapbox offline downloads are real. They are not available to this app, and the
reason is architectural rather than commercial: their offline API lives in the
native Mobile Maps SDK, and everything here renders through Mapbox GL JS inside
a web view. No plan upgrade reaches it. This section is what reaching it would
involve, written down so the decision is made on the size of the job rather
than on a guess about it.

### The part that is easy to underestimate

The basemap is not the map. A native Mapbox view renders *underneath* the web
view — that is how every Capacitor map plugin works — with a transparent hole
punched through the page above it. Everything currently drawn by GL JS would
then be on the wrong side of that hole:

- forty-odd overlays, raster and queried
- the route shields, which are canvases drawn at runtime and registered as map
  images
- every popup, the identify card, the drop-pin flow
- waypoints, folders, imported GPX and KML
- the offline region rectangles

Each of those either moves into Swift against the native SDK, or stays in the
web view and is kept in sync with a camera it no longer owns. Two engines
sharing one camera is the option that looks cheaper and is not: every pan
becomes a bridge message, and the two drift under momentum scrolling.

So this is not "swap the renderer". It is a second implementation of the map
layer, for one platform, in a language the rest of the project does not use.

### What it buys

Genuine offline for the Mapbox basemaps, billed under Mapbox's mobile pricing,
plus native rendering performance and gestures. For a premium tier that is a
real proposition — better than "it looks nicer", which is all a hosted Mapbox
style offers today.

### The order to do it in, if it is done

1. **Protomaps first.** It removes the metered dependency from the default and
   makes offline work for everybody, on both platforms, with no native code. If
   the native path is never taken, the app is still complete.
2. **A native shell for one basemap only.** Prove the plugin, the token, the
   offline region download and the camera bridge with nothing but a basemap on
   screen. No overlays, no shields.
3. **Decide the overlay question with that in hand** — port to Swift, or keep
   the web view drawing over a native basemap and measure the drift honestly
   before committing.

### What cannot be verified from here

None of it. This repository is built and tested on Linux; a native iOS build
needs Xcode, a macOS host, a device or simulator, and a Mapbox download token
that is not in this repo and must not be. Swift written here would compile for
the first time on somebody else's machine.

That matters more than usual for this project, which has spent a lot of effort
on the difference between a service existing and a service answering. Native
code written blind is the same failure with a compiler instead of an HTTP
request: it looks like progress, and the first honest test is the one that has
not happened yet.
