import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SITE } from '../assets/js/config.js';

/*
 * What the shipped HTML has to be true about itself.
 *
 * These pages are hand-written and there is no template engine to keep them
 * honest, so the things that must agree across three files - the app's name,
 * which prose an editor may replace, which markup the JavaScript reaches for -
 * agree only because somebody remembered. Each check below is a thing that has
 * gone wrong or came within one commit of going wrong.
 */

/*
 * Every page the build ships, and this list has to stay level with the one in
 * tools/build-dist.mjs. Two pages were written, linked from the footer, and
 * shipped by neither - the build copies a named list and so does this, so a new
 * page is invisible to both until it is named twice.
 */
const PAGES = ['index.html', 'faq.html', 'account.html', 'map.html', 'terms.html', 'privacy.html', 'admin.html'];

/*
 * The two lists, checked against each other rather than by hand.
 *
 * terms.html and privacy.html were written, linked from the footer, and shipped
 * by nothing: the build copies a named list of pages and so does this file, so
 * a new page is invisible to both until somebody remembers to name it twice.
 * Nothing failed. The footer just linked to a 404 on the live site.
 */
test('pages: the build ships exactly the pages this file checks', async () => {
  const source = await readFile(new URL('../tools/build-dist.mjs', import.meta.url), 'utf8');
  const declared = /const INCLUDE_FILES = \[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(declared, 'INCLUDE_FILES is not where this test expects it');
  const shipped = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...shipped].sort(), [...PAGES].sort(),
    'tools/build-dist.mjs and this list have drifted apart');
});

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

/**
 * The document minus its comments.
 *
 * Not cosmetic: the library section and the Contribute section are commented
 * out rather than deleted, and a check that counted them would be reading
 * markup no browser ever builds. Every question here is about what ships.
 */
const live = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Each `<section …>…</section>` in the document, opening tag and contents. */
function sections(html) {
  const found = [];
  const re = /<section\b([^>]*)>/g;
  let match;
  while ((match = re.exec(html))) {
    const end = html.indexOf('</section>', re.lastIndex);
    assert.notEqual(end, -1, 'a <section> was never closed');
    found.push({ attrs: match[1], body: html.slice(re.lastIndex, end) });
  }
  return found;
}

test('pages: the app calls itself the same thing everywhere', async () => {
  for (const page of PAGES) {
    const html = await read(page);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    assert.ok(title?.includes(SITE.name), `${page}: <title> "${title}" omits ${SITE.name}`);

    const ios = /<meta name="apple-mobile-web-app-title" content="([^"]*)">/.exec(html)?.[1];
    assert.equal(ios, SITE.shortName, `${page}: the iOS home-screen name disagrees with config`);

    const brand = /id="brand-name">([^<]*)</.exec(html)?.[1];
    assert.equal(brand, SITE.name, `${page}: the header brand disagrees with config`);
  }
});

test('pages: the manifest and the native shell call it that too', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.name, SITE.name);
  assert.equal(manifest.short_name, SITE.shortName);
  assert.equal(JSON.parse(await read('capacitor.config.json')).appName, SITE.name);
});

test('pages: every shortcut in the manifest points at a page that exists', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  for (const shortcut of manifest.shortcuts || []) {
    await assert.doesNotReject(read(shortcut.url), `${shortcut.url} is a 404`);
  }
});

test('pages: the homepage catalogue is present or absent as one piece', async () => {
  const html = live(await read('index.html'));
  const used = ['catalog-grid', 'catalog-message', 'search', 'filter-region',
    'filter-tag', 'library-count', 'stat-strip', 'stat-maps', 'stat-distance',
    'stat-waypoints', 'stat-regions'];
  const present = used.filter((id) => html.includes(`id="${id}"`));
  assert.ok(present.length === 0 || present.length === used.length,
    `index.html ships ${present.length} of the catalogue's ${used.length} elements: `
    + `missing ${used.filter((id) => !present.includes(id)).join(', ')}`);
});

/*
 * A comment that contains "--" is not a comment for its whole length.
 *
 * The Contribute section is commented out and its prose mentions CSS custom
 * properties; writing those verbatim would close the comment early and put
 * half a hidden section back on the page. It has been written as "- -" once
 * already for exactly this reason.
 */
test('pages: no commented-out markup closes its own comment early', async () => {
  for (const page of PAGES) {
    for (const [, inner] of (await read(page)).matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.ok(!inner.includes('--'), `${page}: a comment contains "--"`);
    }
  }
});

/*
 * The module graph, discovered at parse time instead of one wave at a time.
 *
 * A browser cannot know map.html needs lib/xml.js until it has fetched and
 * parsed lib/kml.js, which it could not know about until viewer.js: five
 * sequential waves before the GL library was so much as requested. The preload
 * links collapse that, and they are only worth having while they are complete
 * and exact - a stale list silently goes back to discovering the missing half
 * the slow way, and nothing on screen says so.
 */
const importsOf = (source) => [
  ...source.matchAll(/^\s*import\s+(?:[\w*{},\s]+\s+from\s+)?['"](\.[^'"]+)['"]/gm),
].map((m) => m[1]);

async function moduleGraph(entry) {
  const reached = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    let source;
    try {
      source = await read(file);
    } catch {
      continue;
    }
    for (const specifier of importsOf(source)) {
      const resolved = new URL(specifier, new URL(file, 'file:///')).pathname.slice(1);
      if (reached.has(resolved)) continue;
      reached.add(resolved);
      queue.push(resolved);
    }
  }
  return reached;
}

test('pages: the map preloads every module it will import, and only those', async () => {
  const html = await read('map.html');
  const declared = new Set(
    [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]),
  );
  const needed = await moduleGraph('assets/js/viewer.js');

  const missing = [...needed].filter((href) => !declared.has(href)).sort();
  const extra = [...declared].filter((href) => !needed.has(href)).sort();
  const lines = (list) => list.map((href) => `<link rel="modulepreload" href="${href}">`).join('\n');

  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    `map.html's preload list has drifted from the import graph.\n`
    + (missing.length ? `\nAdd:\n${lines(missing)}\n` : '')
    + (extra.length ? `\nRemove:\n${lines(extra)}\n` : ''));
});

/*
 * A preload only preloads if its URL is the one the import will ask for.
 *
 * The build stamps ?v=<hash> onto the assets a page names directly, and module
 * specifiers inside the JavaScript are never rewritten - viewer.js still
 * imports './lib/geo.js'. Stamp a preload and it warms a cache entry nothing
 * reads while the real request goes out unstamped: every file fetched twice,
 * and the optimisation becomes a straight cost. Nothing on the page would look
 * wrong, which is why this is checked here.
 */
test('pages: no preload carries a cache-busting query the import will not', async () => {
  for (const page of PAGES) {
    for (const [, href] of (await read(page)).matchAll(/<link rel="modulepreload" href="([^"]+)">/g)) {
      assert.ok(!href.includes('?'), `${page}: ${href} is preloaded at a URL no import requests`);
    }
  }
});

/*
 * A page that draws the settings menu has to load the CSS that styles it.
 *
 * The menu's markup and its JavaScript were shared across every page before
 * its stylesheet was: the rules lived in viewer.css, which the map alone
 * loads, so the panel opened on the landing page as an unstyled column of
 * inputs spilling down over the headline. Nothing threw, the DOM was correct,
 * and every test passed.
 *
 * Checked by class rather than by filename, because the point is that the
 * rules arrive, not which file carries them.
 */
test('pages: a page with the settings menu loads the CSS that styles it', async () => {
  const styles = new Map();
  for (const file of ['assets/css/site.css', 'assets/css/viewer.css']) {
    styles.set(file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  }

  /*
   * Read out of the modules rather than written down here.
   *
   * The first version of this test carried a hand-written list of four
   * classes, and passed while .hint and .toast were still map-only - so the
   * sign-in explanation rendered near-invisible and every error message landed
   * unstyled at the foot of the document, which is how a failed sign-in came
   * to look like a button that does nothing. A list somebody has to remember
   * to extend is a list that documents the bugs already found.
   *
   * So the shared modules are asked what they draw. Static class attributes
   * only; the two interpolated ones are named below, since a regex cannot
   * evaluate a template literal.
   */
  const SHARED = [
    'assets/js/lib/account-panel.js',
    'assets/js/lib/settings-menu.js',
    'assets/js/lib/page-settings.js',
    'assets/js/lib/delete-account.js',
    'assets/js/lib/ui.js',
  ];
  const emitted = new Set(['toast', 'toast-stack', 'settings-choice']);
  for (const file of SHARED) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/class: '([^']+)'/g)) {
      for (const name of match[1].split(/\s+/)) {
        if (name && !name.startsWith('is-')) emitted.add(name);
      }
    }
  }
  /*
   * Classes that exist to be selected, not to be styled.
   *
   * .account-edit is how the smoke run finds the Edit profile button; the
   * button itself is an ordinary bordered button and needs no rule of its own.
   * Demanding one would mean inventing CSS to satisfy a test, which is the
   * wrong direction - but the exception is listed here rather than inferred,
   * so a class that quietly stops being styled still fails.
   */
  const HOOKS_ONLY = new Set(['account-edit']);
  const NEEDED = [...emitted].filter((name) => !HOOKS_ONLY.has(name))
    .map((name) => `.${name}`).sort();
  assert.ok(NEEDED.length > 15, `expected to find the panel's classes, found ${NEEDED.length}`);
  const unstyled = [];

  for (const page of PAGES) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    if (!html.includes('id="settings-panel"')) continue;

    const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
      .map((match) => match[1]);
    const css = sheets.map((href) => styles.get(href) || '').join('\n');

    /*
     * A rule of its own, not merely the characters somewhere in the file.
     *
     * An earlier version of this asked whether the stylesheet contained the
     * string ".hint", and `#account-panel .hint { overflow-wrap: anywhere }`
     * answered yes - so the check passed while the rule that gives .hint its
     * colour and size was still map-only. Requiring the class at the head of a
     * selector is what tells "styled here" from "mentioned here".
     */
    for (const rule of NEEDED) {
      const standalone = new RegExp(`(?:^|[,{}])\\s*\\${rule}(?![\\w-])`, 'm');
      if (!standalone.test(css)) unstyled.push(`${page} draws the settings menu but no stylesheet it loads defines ${rule}`);
    }
  }

  assert.deepEqual(unstyled, [], 'the panel would render unstyled on these pages');
});

/*
 * The panel that could take a password and do nothing with it.
 *
 * mountPageSettings built an Account and never called init(), and init() is
 * where every moving part is: the existing session is read there, the plan is
 * fetched there, the provider buttons are decided there, and
 * onAuthStateChange - the thing that tells the panel a sign-in worked - is
 * subscribed there.
 *
 * So index, faq, terms and privacy shipped a form that handed credentials to
 * Supabase, got a session back, and redrew nothing. It was reported as "can't
 * sign in - no error message displayed", and there was no error: the sign-in
 * succeeded, server-side, at the minute of the screenshot. The panel simply
 * never heard.
 *
 * Structural rather than behavioural because there is no DOM in this suite,
 * and the failure was structural: a call that was not there.
 */
test('pages: an account the settings menu builds is one it starts', async () => {
  const source = await readFile(new URL('../assets/js/lib/page-settings.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /\bwho\.init\(\)/,
    'mountPageSettings builds an Account but never calls init(), so the panel '
    + 'cannot hear a sign-in, read a session, or fetch a plan',
  );
});

test('pages: a page bringing its own account starts it itself', async () => {
  /*
   * The other half of the rule above. mountPageSettings deliberately does not
   * init an account it was handed - admin.js owns that one, and a second
   * subscription would redraw twice per sign-in - so the page that hands one
   * over has to start it.
   */
  const unstarted = [];
  for (const file of ['assets/js/admin.js', 'assets/js/home.js', 'assets/js/faq.js', 'assets/js/viewer.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const handsOne = /mountPageSettings\(\{[^}]*\baccount\b/.test(source);
    if (handsOne && !/\.init\(\)/.test(source)) unstarted.push(file);
  }
  assert.deepEqual(unstarted, [], 'these pass their own Account to the settings menu and never start it');
});

/*
 * The help page sends people to a button, so the button has to be there.
 *
 * "Manage subscription in the account menu" was true on the map and nowhere
 * else, because only viewer.js passed a planExtra to the settings menu. So
 * somebody who opened the gear on the help page - having been told to by the
 * help page - found a plan name and nothing under it. Reported as exactly
 * that.
 *
 * Checked at the source rather than in a browser because the browser check
 * needs a subscription to exist; this one holds whether or not anybody has
 * one, and it is the half that would go quiet if the wiring were dropped.
 */
test('pages: the help page points at a button every page actually has', async () => {
  const faq = await readFile(new URL('../faq.html', import.meta.url), 'utf8');
  if (!/Manage subscription/.test(faq)) return;   // nothing claimed, nothing to keep true

  const shared = await readFile(new URL('../assets/js/lib/page-settings.js', import.meta.url), 'utf8');
  assert.match(
    shared,
    /planExtra:\s*\(plan\)\s*=>\s*managePlanBlock/,
    'faq.html sends people to Manage subscription, but the settings menu off the '
    + 'map is built without a plan block, so there is no such button there',
  );

  // And the block itself still answers for a Stripe subscription.
  const block = await readFile(new URL('../assets/js/lib/manage-plan.js', import.meta.url), 'utf8');
  assert.match(block, /source === 'stripe'/, 'the manage block no longer recognises a Stripe subscription');
  assert.match(block, /Manage subscription/, 'the manage block no longer draws the button the help page names');
});

test('pages: a page with no folder store does not sync one', async () => {
  /*
   * These hold a stub folder store with nothing in it. Left to sync, they
   * fetched every folder row on load to merge into nothing, and on a refused
   * network wrote "Sync failed: TypeError: Failed to fetch" into a panel on a
   * page that has never synced anything.
   *
   * Not a data hazard - an empty local set pulls the remote folders rather
   * than deleting them, because deletions travel as tombstones and a merge
   * from empty pushes nothing - but waste, and a false alarm in front of
   * somebody who has twenty-seven folders on the map page.
   */
  const unguarded = [];
  for (const file of ['assets/js/lib/page-settings.js', 'assets/js/admin.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    if (!/new Account\([^)]*\{[^}]*syncs:\s*false/.test(source)) unguarded.push(file);
  }
  assert.deepEqual(unguarded, [], 'these build an Account over a stub folder store and let it sync');
});

/*
 * The plan is drawn by the settings menu, so the settings menu has to be told.
 *
 * viewer.js rebuilt the account card and the layer list when the account
 * changed, and never repainted the menu - so the plan was whatever it had been
 * when the gear was opened, for ever. my_plan() answers a moment after load,
 * so opening the gear in that moment showed Free to somebody who subscribes
 * and went on showing it until the page was reloaded. Reported as the map
 * taking a long time to load the plan and needing a refresh.
 *
 * Every other page has done this since the gear shipped; only the map was
 * missing it, which is why this is checked per page rather than in one place.
 */
test('pages: the plan catches up on its own, on the map as well as off it', async () => {
  const missing = [];
  for (const file of ['assets/js/viewer.js', 'assets/js/lib/page-settings.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const onChange = source.match(/addEventListener\('change',[\s\S]{0,3200}?\n {2}\}\);/g) || [];
    if (!onChange.some((block) => /\bpaint\(\)/.test(block))) missing.push(file);
  }
  assert.deepEqual(missing, [],
    'these listen for account changes without repainting the settings menu, so the plan goes stale');
});

/*
 * What is typed into the password form has to outlive a redraw.
 *
 * render() rebuilds this panel from scratch, so anything landing while
 * somebody types - a plan arriving, a sync finishing - replaced both fields
 * with empty ones. On a field of dots that is invisible, and what it produces
 * is "those two passwords are not the same" about two passwords that were
 * typed identically. The profile form has always held its draft outside the
 * inputs for this reason; the password form did not.
 */
test('pages: the password form does not keep its only copy in the DOM', async () => {
  const source = await readFile(new URL('../assets/js/lib/account-panel.js', import.meta.url), 'utf8');
  assert.match(source, /let passwordDraft/, 'the password form has no draft outside the inputs');

  const form = source.slice(source.indexOf('function passwordForm'), source.indexOf('function render'));
  assert.match(form, /value: draft\.first/, 'the field does not start from the draft, so a redraw empties it');
  assert.match(form, /value: draft\.again/, 'the confirm field does not start from the draft');
  assert.match(form, /draft\.first = event\.target\.value/, 'typing is not recorded outside the input');
  assert.match(form, /draft\.again = event\.target\.value/, 'typing in the confirm field is not recorded');
});

/*
 * A link from an inbox that did not work has to say so where it is seen.
 *
 * The message renders inside the account panel, and the panel is shut when a
 * page loads - so somebody who followed a reset link got a page that looked
 * like an ordinary visit, and found the explanation only by opening the gear
 * for unrelated reasons. Reported as exactly that.
 */
test('pages: a failed email link is put in front of somebody', async () => {
  const account = await readFile(new URL('../assets/js/lib/account.js', import.meta.url), 'utf8');
  assert.match(account, /this\.linkFailed = true/,
    'nothing records that the page was opened by a link that failed');

  const page = await readFile(new URL('../assets/js/lib/page-settings.js', import.meta.url), 'utf8');
  assert.match(page, /who\.linkFailed/, 'the page never reads the flag');
  assert.match(page, /menu\.setOpen\(true\)[\s\S]{0,200}toast\(who\.message/,
    'it should both open the menu and say it out loud');
});

/*
 * And the map is where those links actually arrive.
 *
 * index.html forwards any address carrying an auth fragment straight on to
 * map.html - deliberately, so that a shared link or a returning session is not
 * dropped on a landing page - which makes the map the one page a reset link
 * from an inbox is certain to reach. It was also the one page that did nothing
 * with it: the session was created, the panel was ready to draw the form, and
 * the gear stayed shut. Reported as "it did nothing but bring up the map while
 * logged in", and the auth log showed a 303 and a login, so the link was never
 * the problem.
 */
test('pages: a reset link that lands on the map is acted on', async () => {
  const home = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(home, /access_token=[\s\S]{0,200}location\.replace\('map\.html'/,
    'the homepage no longer forwards an auth fragment, so this guard is about the wrong page');

  const viewer = await readFile(new URL('../assets/js/viewer.js', import.meta.url), 'utf8');
  const onChange = viewer.match(/state\.account\.addEventListener\('change',[\s\S]*?\n {2}\}\);/);
  assert.ok(onChange, 'the map stopped listening for account changes');

  assert.match(onChange[0], /recovering[\s\S]{0,80}setOpen\(true\)/,
    'the map never opens the gear on a recovery, so the password form stays hidden');
  assert.match(onChange[0], /linkFailed[\s\S]{0,300}toast\(/,
    'the map never says a link failed, which is how a sign-out looks random');
});

/*
 * The event that flag depends on is announced on a timer, and can be missed.
 *
 * supabase-js reads the fragment while the client is being built, saves the
 * session, then schedules PASSWORD_RECOVERY for the next tick. getSession()
 * waits for all of it, so a subscriber registered after that call is in place
 * only after the announcement has gone out to nobody. Observed in a browser
 * against the real library: a recovery link delivered INITIAL_SESSION and
 * nothing else, on every page, and the reset route silently did nothing.
 */
/*
 * The gear is for settings, and the account has a page.
 *
 * Everything about an account had to fit in a dropdown built for three rows:
 * the profile, the password, the plan. It did not - "Edit profile" was cut to
 * "Edit" because the longer label clipped, and closing an account was moved
 * out to the help page for room as much as for safety. What is left in the
 * menu is who you are and a way out of it.
 */
test('pages: the gear holds a way to the account, not the account', async () => {
  const panel = await readFile(new URL('../assets/js/lib/account-panel.js', import.meta.url), 'utf8');
  assert.match(panel, /compact\s*=\s*false/, 'the panel cannot be asked to be compact');
  assert.match(panel, /compact[\s\S]{0,200}href: 'account\.html'/,
    'a compact panel should offer the page rather than unfold a form');

  for (const file of ['assets/js/lib/page-settings.js', 'assets/js/viewer.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /createAccountPanel\(\{[\s\S]{0,400}compact: true/,
      `${file} builds the gear's panel at full size, so the forms are back in the menu`);
  }

  /*
   * And the gear on that page does not also open on a reset link: the page
   * renders the form in the document, so opening the menu as well stacked a
   * second password form in a dropdown over the first.
   */
  const shared = await readFile(new URL('../assets/js/lib/page-settings.js', import.meta.url), 'utf8');
  assert.match(shared, /handlesInboxLinks/, 'the gear cannot be told it is not the landing spot');
  assert.match(shared, /recovering && menu && handlesInboxLinks/,
    'the gear opens on a recovery whatever the page around it is doing');
  const entry = await readFile(new URL('../assets/js/account.js', import.meta.url), 'utf8');
  assert.match(entry, /handlesInboxLinks: false/, 'account.html lets its own gear open over its form');

  /*
   * And signed out, the compact panel offers the page instead of the form.
   * Ten controls in a dropdown that already scrolls on a phone is a settings
   * menu you have to scroll past the account to reach the settings in.
   */
  assert.match(panel, /if \(compact\) \{[\s\S]{0,400}href: 'account\.html'/,
    'the gear builds the whole sign-in form again when nobody is signed in');

  // And the page is the one place that gets the full thing.
  const page = await readFile(new URL('../assets/js/lib/account-page.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /compact:\s*true/, 'the account page asked for the cut-down panel');
  assert.doesNotMatch(page, /id: 'account-panel'/,
    'the page and the gear would both claim #account-panel, which resolves to the header');
});

/*
 * A toast about the thing you are doing must not put that thing away.
 *
 * The dismiss button hangs off the body, so its click counted as a click
 * outside the settings menu and closed it - while somebody was reading a
 * complaint about the form inside it. The sign-in form is still in there, so
 * this still matters; it is a source guard because the browser check that
 * found it now runs on the account page, which has no menu to close.
 */
test('pages: dismissing a toast does not count as a click outside the menu', async () => {
  const ui = await readFile(new URL('../assets/js/lib/ui.js', import.meta.url), 'utf8');
  assert.match(ui, /stack\.addEventListener\('click',[\s\S]{0,120}?stopPropagation/,
    'the toast stack lets its clicks reach the document handler that shuts the gear');
});

test('account: the auth listener is in place before the session is asked for', async () => {
  const source = await readFile(new URL('../assets/js/lib/account.js', import.meta.url), 'utf8');
  const init = source.slice(source.indexOf('async init()'), source.indexOf('async signUp'));

  const listening = init.indexOf('onAuthStateChange');
  const asking = init.indexOf('auth.getSession()');
  assert.ok(listening > 0 && asking > 0, 'init() no longer does both of these');
  assert.ok(listening < asking,
    'getSession() is awaited first, so PASSWORD_RECOVERY is announced before anything is listening');

  assert.match(init, /if \(!this\.recovering\) this\.setStatus/,
    'the status set after getSession() would overwrite what a recovery already said');
});

/*
 * And the update reload must not interrupt one.
 *
 * Supabase hands the session back in the fragment and reads it out on load.
 * Reloading the page mid-exchange turns a working link into a failed one, and
 * a recovery link is single use - there is no second attempt to spend.
 */
test('pages: taking a new build waits while an auth link is being read', async () => {
  const pwa = await readFile(new URL('../assets/js/lib/pwa.js', import.meta.url), 'utf8');
  const fn = pwa.slice(pwa.indexOf('export async function reloadOntoNewBuild'));
  assert.match(fn, /access_token|type=recovery/,
    'reloadOntoNewBuild does not check for an auth fragment before reloading');
  assert.ok(
    fn.indexOf('access_token') < fn.indexOf('applyServiceWorkerUpdate'),
    'the check has to come before the hand-over, or the reload has already happened',
  );
});
