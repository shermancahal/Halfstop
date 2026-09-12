/**
 * Where Stripe is allowed to send somebody back to.
 *
 * Checked rather than trusted. `success_url` and `cancel_url` are whatever the
 * request asked for, and an unchecked one is an open redirect with our own
 * domain in the referrer and a payment just behind it - which is the shape of
 * a convincing phishing page.
 *
 * Its own file, and pure, because the interesting part is a string comparison
 * that is easy to get subtly wrong and impossible to test through a deployed
 * function that also needs Stripe, Supabase and a signed-in caller.
 */

/**
 * A development server, and only while the keys are test keys.
 *
 * Without this a checkout started on `npm start` sends the browser to the
 * production site afterwards - a different origin, so a different session, so
 * the person who just paid lands somewhere they are not signed in. The
 * subscription is real and the ending is baffling.
 *
 * Loopback only: `localhost` and `127.0.0.1` name the machine the browser is
 * running on, so the worst a wrong answer here can do is send somebody back to
 * their own computer. Anything that resolves through DNS - a hostname that
 * merely begins with "localhost", say - is not this.
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/**
 * @param {string} asked     what the browser sent
 * @param {string} site      the one origin this project serves from
 * @param {boolean} testMode whether the Stripe key is a test key
 */
export function allowedReturn(asked, site, testMode = false) {
  const want = String(asked || '');
  /*
   * Falls back to the site rather than refusing.
   *
   * A checkout is worth completing even when the return address is wrong: the
   * payment is the thing somebody came to do, and landing on the front page
   * afterwards is a small confusion next to being told their purchase could
   * not be started because of a query string.
   */
  if (!site) return '';
  if (want.startsWith(site)) return want;
  if (testMode && LOOPBACK.test(want)) return want;
  return site;
}

/** The success URL, with the flag the app reads on landing. */
export function withFlag(returnTo, flag = 'subscribed=1') {
  return `${returnTo}${returnTo.includes('?') ? '&' : '?'}${flag}`;
}
