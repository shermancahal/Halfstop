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
 *     https://app.halfstop.app/*
 *     https://your-domain.example/*
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

/**
 * Where to ask for a road route. Empty means FOSSGIS's public Valhalla.
 *
 * Not a secret, and not code: it is the one line that moves routing off
 * somebody else's server and onto yours. FOSSGIS's own terms ask that their
 * URLs not be hardcoded, which is why it is a setting at all.
 *
 * The default is right for development and for a quiet site, and wrong for a
 * product. Their terms permit commercial use "only ... if the use of the
 * services does not constitute a substantial part of an online offering", cap
 * the routing servers at one request per second, and say plainly that websites
 * with high traffic are not permitted. A trip planner's routing is a
 * substantial part of the offering, so a paid or ad-supported tier needs its
 * own Valhalla first.
 *
 * Self-hosting means a server you run, not something on the reader's phone:
 * Valhalla is a C++ service over a routing graph that is hundreds of megabytes
 * for a single state. It speaks this same API, so the switch is this string.
 * See docs/routing.md.
 */
window.ABMAP_ROUTING_URL = '';

/**
 * Billing, which is off unless these say otherwise.
 *
 * `LIVE` closes the feature gates — Premium features stop working for accounts
 * that do not have Premium. `STORE` is what offers a way to buy: 'stripe' in a
 * browser, 'appstore' once there is a native app, 'none' or empty for neither.
 * They are separate on purpose, so the gates can be proven with nothing for
 * sale, and a store can be wired up while everything is still free.
 *
 * Not committed defaults, because a `true` in the repository would put a
 * Subscribe button on the public site the moment it deployed — and while the
 * Stripe keys are test-mode keys that is worse than useless: anybody could pay
 * with 4242 4242 4242 4242, have no money leave their account, and come away
 * with a real entitlement row.
 */
window.ABMAP_BILLING_LIVE = '';
window.ABMAP_BILLING_STORE = '';

/**
 * Who sees the purchase panel while billing is off, comma separated.
 *
 * This is how you test a checkout before anybody else can reach one: put your
 * own address here, sign in as it, and the plan panel draws the Subscribe
 * buttons labelled *Test mode*.
 *
 * It decides which button is drawn and nothing more. Who may actually pay is
 * decided by `BILLING_TESTERS` on the Supabase Edge Functions, which refuse
 * anybody not on their list while the Stripe key is a test key. That split is
 * deliberate: this file runs on the reader's computer, where they can edit it,
 * so it cannot be the thing that grants anybody anything.
 *
 * Keep it local if you can. The deploy writes this same file from a repository
 * secret, and the file is served to every visitor — so an address set there is
 * readable by anybody who views source, while an address set here is not.
 */
window.ABMAP_BILLING_TESTERS = '';
