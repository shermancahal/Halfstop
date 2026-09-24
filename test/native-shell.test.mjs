/**
 * The app being opened by its own links, and sign-in going out through the
 * system browser.
 *
 * None of this can run here - it needs a phone - so what is pinned is the part
 * that decides things: which page a link lands on, what it carries there, and
 * that a link which started the app is followed once rather than on every
 * page load after it. Those are the places a mistake is silent on the device:
 * a recovery link that lands on the map shows no password form, and a launch
 * link followed on every load is an app that cannot be used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_RETURN, APP_SCHEME, LAUNCH_KEY, RETURN_KEY,
  appShell, landingFor, navigate, rememberReturn, takeReturn, watchAppLinks,
} from '../assets/js/lib/native-shell.js';
import { Account } from '../assets/js/lib/account.js';

/** A Storage with the three methods anything here calls. */
function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

/** What Capacitor's native bridge puts on window, for one platform. */
function capacitor(platform, plugins = {}) {
  return {
    Capacitor: {
      isNativePlatform: () => platform !== 'web',
      getPlatform: () => platform,
      Plugins: plugins,
    },
  };
}

/* ------------------------------------------------------------------ shell */

test('shell: a browser is a browser, and reaches no plugins', () => {
  const shell = appShell({});
  assert.equal(shell.native, false);
  assert.equal(shell.platform, 'web');
  assert.equal(shell.plugin('App'), null);
});

test('shell: the Android app says so, and hands over what it compiled in', () => {
  const App = { addListener() {} };
  const shell = appShell(capacitor('android', { App }));
  assert.equal(shell.native, true);
  assert.equal(shell.platform, 'android');
  assert.equal(shell.plugin('App'), App);
  // A plugin this build does not have is an answer, not an exception: an
  // app installed before the plugin was added is exactly that.
  assert.equal(shell.plugin('Browser'), null);
});

test('shell: a Capacitor global that throws does not break the page', () => {
  // Anything can define the global. Deciding whether this is the app must not
  // be the thing that breaks the website.
  const shell = appShell({ Capacitor: { isNativePlatform() { throw new Error('no'); } } });
  assert.equal(shell.native, false);
  assert.equal(shell.platform, 'web');
});

test('shell: Capacitor in a browser is still the website', () => {
  // @capacitor/core defines the global on the web too, reporting "web".
  const shell = appShell(capacitor('web', { App: {} }));
  assert.equal(shell.native, false);
  assert.equal(shell.plugin('App'), null);
});

/* ---------------------------------------------------------------- landing */

test('landing: the return address is the app\'s scheme', () => {
  assert.equal(APP_RETURN, `${APP_SCHEME}://account`);
});

test('landing: a link that is not the app\'s goes nowhere', () => {
  assert.equal(landingFor('https://app.halfstop.app/account.html#access_token=a'), null);
  assert.equal(landingFor('not a url'), null);
  assert.equal(landingFor(''), null);
});

test('landing: an emailed link lands on the account page with its session', () => {
  // `type` is what every emailed link carries. A recovery has to reach the
  // page with the new-password form on it, whatever page Google left behind.
  const link = `${APP_RETURN}#access_token=a&refresh_token=r&type=recovery`;
  assert.equal(landingFor(link, { remembered: '/map.html?m=x' }),
    'account.html#access_token=a&refresh_token=r&type=recovery');
  assert.equal(landingFor(`${APP_RETURN}#access_token=a&type=signup`), 'account.html#access_token=a&type=signup');
});

test('landing: a finished Google sign-in goes back to the page it left', () => {
  const link = `${APP_RETURN}#access_token=a&refresh_token=r&token_type=bearer`;
  assert.equal(landingFor(link, { remembered: '/map.html?m=x' }),
    '/map.html?m=x#access_token=a&refresh_token=r&token_type=bearer');
  // And to the account page when nothing was kept.
  assert.equal(landingFor(link), 'account.html#access_token=a&refresh_token=r&token_type=bearer');
});

test('landing: a refusal in the query arrives in the fragment, on the account page', () => {
  // The page reads only the fragment, and only the account page says a
  // failed link out loud - anywhere else it would be a silent signed-out page.
  const link = `${APP_RETURN}?error=access_denied&error_description=Email+link+is+invalid`;
  assert.equal(landingFor(link, { remembered: '/map.html' }),
    'account.html#error=access_denied&error_description=Email+link+is+invalid');
});

test('landing: a bare link opens the account page', () => {
  assert.equal(landingFor(APP_RETURN), 'account.html');
});

/* ------------------------------------------------------ remembering a page */

test('return: kept once, with its query and without its fragment', () => {
  const store = memoryStore();
  rememberReturn(store, { pathname: '/map.html', search: '?m=x', hash: '#stale' });
  assert.equal(store.getItem(RETURN_KEY), '/map.html?m=x');
  assert.equal(takeReturn(store), '/map.html?m=x');
  // Once: a stale page must not pull the next emailed link somewhere else.
  assert.equal(takeReturn(store), '');
});

test('return: only a path on this origin is ever handed back', () => {
  assert.equal(takeReturn(memoryStore({ [RETURN_KEY]: '//elsewhere.example/x' })), '');
  assert.equal(takeReturn(memoryStore({ [RETURN_KEY]: 'https://elsewhere.example/' })), '');
  assert.equal(takeReturn(null), '');
});

/* -------------------------------------------------------------- navigating */

function fakeLocation(href) {
  const url = new URL(href);
  const seen = [];
  return {
    seen,
    href: url.href,
    pathname: url.pathname,
    search: url.search,
    set hash(value) { seen.push(['hash', value]); },
    assign(next) { seen.push(['assign', next]); },
    reload() { seen.push(['reload']); },
  };
}

test('navigate: another page is loaded', () => {
  const where = fakeLocation('https://localhost/map.html?m=x');
  navigate('account.html#access_token=a', where);
  assert.deepEqual(where.seen, [['assign', 'https://localhost/account.html#access_token=a']]);
});

test('navigate: the page already open is reloaded, not scrolled', () => {
  // A fragment-only change loads nothing, and supabase-js reads the fragment
  // only while the client is being built - so without the reload the session
  // in it is never seen.
  const where = fakeLocation('https://localhost/account.html');
  navigate('account.html#access_token=a', where);
  assert.deepEqual(where.seen, [['hash', '#access_token=a'], ['reload']]);
});

/* --------------------------------------------------------------- watching */

function fakeApp({ launch = null } = {}) {
  const listeners = {};
  return {
    listeners,
    addListener(name, fn) { listeners[name] = fn; return Promise.resolve({ remove() {} }); },
    async getLaunchUrl() { return launch ? { url: launch } : undefined; },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('watch: a browser listens for nothing', () => {
  assert.equal(watchAppLinks({ shell: appShell({}) }), false);
});

test('watch: a link tapped while the app is open is followed', async () => {
  const App = fakeApp();
  const gone = [];
  const store = memoryStore();
  rememberReturn(store, { pathname: '/map.html', search: '' });

  assert.equal(watchAppLinks({ shell: appShell(capacitor('android', { App })), store, go: (to) => gone.push(to) }), true);
  App.listeners.appUrlOpen({ url: `${APP_RETURN}#access_token=a&refresh_token=r` });
  await settle();

  assert.deepEqual(gone, ['/map.html#access_token=a&refresh_token=r']);
  // Somebody else's link opening the app is not ours to follow.
  App.listeners.appUrlOpen({ url: 'https://example.com/' });
  assert.equal(gone.length, 1);
});

test('watch: the link that started the app is followed once, not on every load', async () => {
  // getLaunchUrl answers with the same URL for as long as the app runs, and
  // following it lands on a new page that asks again. Without the memory,
  // that is a loop the app cannot be used through.
  const link = `${APP_RETURN}#access_token=a&type=magiclink`;
  const store = memoryStore();
  const gone = [];
  const load = async () => {
    watchAppLinks({ shell: appShell(capacitor('android', { App: fakeApp({ launch: link }) })), store, go: (to) => gone.push(to) });
    await settle();
  };

  await load();
  await load();
  await load();

  assert.deepEqual(gone, ['account.html#access_token=a&type=magiclink']);
  assert.equal(store.getItem(LAUNCH_KEY), link);
});

test('watch: with no storage, a launch link is left alone rather than looped on', async () => {
  const gone = [];
  watchAppLinks({
    shell: appShell(capacitor('android', { App: fakeApp({ launch: `${APP_RETURN}#access_token=a` }) })),
    store: null,
    go: (to) => gone.push(to),
  });
  await settle();
  assert.deepEqual(gone, []);
});

/* ------------------------------------------------ the account, in the app */

function authClient() {
  const calls = [];
  return {
    calls,
    auth: {
      async signUp(options) { calls.push(['signUp', options]); return { data: { session: null }, error: null }; },
      async signInWithOtp(options) { calls.push(['signInWithOtp', options]); return { error: null }; },
      async resetPasswordForEmail(email, options) { calls.push(['resetPasswordForEmail', email, options]); return { error: null }; },
      async signInWithOAuth(options) {
        calls.push(['signInWithOAuth', options]);
        return { data: { url: 'https://auth.halfstop.app/auth/v1/authorize?provider=google' }, error: null };
      },
    },
  };
}

test('account: in the app, every emailed link comes back to the app', async (t) => {
  // The page's own address is https://localhost - the phone's web view, and
  // nowhere a mail client can reach.
  const previous = globalThis.Capacitor;
  globalThis.Capacitor = capacitor('android').Capacitor;
  globalThis.window = { location: { href: 'https://localhost/map.html', hash: '' } };
  t.after(() => { globalThis.Capacitor = previous; });

  const client = authClient();
  const account = new Account({ list: () => [] }, { client: async () => client, configured: () => true });
  await account.signUp('a@example.com', 'secret');
  await account.signInWithLink('a@example.com');
  await account.resetPassword('a@example.com');

  assert.deepEqual(client.calls.map((call) => (call[0] === 'resetPasswordForEmail'
    ? call[2].redirectTo : call[1].options.emailRedirectTo)), [APP_RETURN, APP_RETURN, APP_RETURN]);
});

test('account: in the app, Google opens in the system browser and returns to the app', async (t) => {
  const opened = [];
  const Browser = { async open({ url }) { opened.push(url); } };
  const store = memoryStore();
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = store;
  globalThis.location = { pathname: '/map.html', search: '?m=x' };
  t.after(() => { globalThis.sessionStorage = previous; delete globalThis.location; });

  const client = authClient();
  const account = new Account({ list: () => [] }, {
    client: async () => client, configured: () => true,
    shell: () => appShell(capacitor('android', { Browser })),
  });
  await account.signInWithProvider('google');

  const [[, options]] = client.calls;
  assert.equal(options.provider, 'google');
  assert.equal(options.options.redirectTo, APP_RETURN);
  // Handed back rather than navigated to: Google refuses an embedded web view.
  assert.equal(options.options.skipBrowserRedirect, true);
  assert.deepEqual(opened, ['https://auth.halfstop.app/auth/v1/authorize?provider=google']);
  // And the page is kept, so the return lands where somebody pressed it.
  assert.equal(store.getItem(RETURN_KEY), '/map.html?m=x');
});

test('account: an app without the browser plugin says so rather than failing inside Google', async () => {
  const client = authClient();
  const account = new Account({ list: () => [] }, {
    client: async () => client, configured: () => true,
    shell: () => appShell(capacitor('android', {})),
  });
  await assert.rejects(account.signInWithProvider('google'), /Update it/);
  assert.deepEqual(client.calls, [], 'a sign-in was started that could only end in disallowed_useragent');
});
