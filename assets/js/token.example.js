/**
 * Mapbox access token — copy this file to `token.js` and fill in your token.
 *
 * `token.js` is gitignored on purpose. A Mapbox `pk.` token is a *public*
 * token, designed to be readable in browser code, so shipping it to your web
 * server is fine and expected. Keeping it out of the repository is still worth
 * doing: GitHub's secret scanner blocks pushes that contain one, and anything
 * committed to git stays in the history long after you rotate the token.
 *
 * Restrict the token to your domains in the Mapbox dashboard (Account →
 * Tokens → URL restrictions), for example:
 *     https://shermanc8.sg-host.com/*
 *     https://americanbyways.com/*
 *
 * Leave it empty and the site runs on the open USGS / Esri / OpenStreetMap
 * basemaps with no account at all.
 */
window.ABMAP_MAPBOX_TOKEN = '';

/**
 * A SECOND `pk.` token, for the iOS and Android app only. Leave it empty
 * unless you are building the Capacitor shell.
 *
 * It has to be separate, and it has to be unrestricted. A Capacitor webview
 * loads from `capacitor://localhost` or `https://localhost` and sends no
 * `Referer` header at all, so the URL restriction that protects the website's
 * token rejects every request from inside the app — a blank map and a 401 in a
 * console nobody is watching.
 *
 * Keeping the two apart is what makes that safe: an IPA or an APK is a zip,
 * anyone can read strings out of one, and a token pulled out of a binary
 * should cost a single revocation rather than take the website down with it.
 * Give it the same three scopes (Styles:Tiles, Styles:Read, Fonts:Read) and
 * set a usage limit on it in the Mapbox dashboard.
 *
 * `node tools/build-dist.mjs --app` uses this one; a normal build ignores it
 * and does not ship it. See docs/mobile-app.md.
 *
 * Never an `sk.` token here — a secret token can create and delete tokens, and
 * this file is shipped to the browser.
 */
window.ABMAP_MAPBOX_TOKEN_APP = '';

/**
 * Supabase, for optional accounts and folder sync. Leave empty to run without
 * accounts. Use the PUBLISHABLE key (sb_publishable_… or the anon key) — never
 * the secret key, which bypasses all row-level security.
 */
window.ABMAP_SUPABASE_URL = '';
window.ABMAP_SUPABASE_KEY = '';

/**
 * The Protomaps archive Byways Topo draws from, when there is one.
 *
 * One `.pmtiles` file holding the whole basemap, read a slice at a time over
 * HTTP range requests. Set it and Byways Topo draws from it — free to look at,
 * and downloadable, because the whole map is one file. Leave it empty and
 * Byways Topo draws from Mapbox exactly as before.
 *
 * Not a secret: it is a public URL on a public bucket. It lives here because
 * it is deployment configuration rather than code, and it differs between a
 * local checkout, the site and the app bundle.
 *
 * Whatever hosts it must send CORS headers and honour Range requests, or the
 * browser cannot read a slice of it. See docs/protomaps.md.
 */
window.ABMAP_PROTOMAPS_ARCHIVE = '';

/**
 * How deep that archive goes. 15 is what the Protomaps daily builds reach, and
 * what the app assumes when this is empty.
 *
 * Getting it wrong is not symmetrical: understating it costs detail, because
 * the deepest tile is stretched past it, while overstating it asks for tiles
 * the archive does not contain and draws blank ground. The app reads the
 * archive's own header when it opens it and says so in the console if the two
 * disagree, so this is checkable rather than a guess you have to live with.
 */
window.ABMAP_PROTOMAPS_MAXZOOM = '';
