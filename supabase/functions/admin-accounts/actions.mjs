/**
 * What an administrator is allowed to do to an account, decided in one place.
 *
 * Pure, and plain JavaScript, for the same reason as the Stripe webhook's
 * events.mjs: this decides who may delete somebody's account and who may be
 * handed Premium, and reading it carefully is not the same as testing it. A
 * permissive bug here does not look like a failure. It looks like a stranger
 * with the service key's reach.
 *
 * NOTHING IN HERE TRUSTS THE BROWSER
 *
 * admin.html checks `SITE.editors` before it draws the page, and that check is
 * presentation: anybody can edit it in devtools. The address that decides is
 * the one in the verified JWT, compared against ADMIN_EMAILS on the function,
 * which is a value the browser cannot reach at all.
 */

/** Addresses that may use this function, from the function's own environment. */
export function administrators(raw) {
  return String(raw || '')
    .split(',')
    .map((one) => one.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether this caller may act at all.
 *
 * An empty list is nobody rather than everybody. A misconfigured function that
 * let the whole internet manage accounts, because a variable was unset, is the
 * exact failure the default has to refuse.
 */
export function mayAdminister(email, raw) {
  const allowed = administrators(raw);
  if (!allowed.length) return false;
  return allowed.includes(String(email || '').trim().toLowerCase());
}

/** The actions this function answers to, and nothing else. */
export const ACTIONS = ['list', 'invite', 'setPlan', 'delete'];

/**
 * The three plans an account can be put on, by name.
 *
 * This replaced a pair of buttons - Grant Premium and Revoke Premium - that
 * between them could only express two of the three states. Free and Premium
 * were reachable and Trial was not, because a trial was computed from the
 * account's creation date and there was nothing to set. So the one state with
 * a clock on it, which is the one worth being able to put somebody into for
 * testing or for a friend who wants to look before paying, was the state the
 * tool could not reach.
 *
 * Named rather than toggled for a second reason: a toggle asks "is this on",
 * which has no answer when there are three. Somebody pressing Trial against an
 * account already on Trial should get a trial, not whatever the opposite of
 * one is.
 */
export const PLANS = ['free', 'trial', 'premium'];

/**
 * How long a trial runs when this tool starts one.
 *
 * Said in three places, on purpose, because each of them has to work without
 * the other two: public.start_trial() in the database is the one that decides
 * when somebody opts in themselves, assets/js/lib/tiers.js is what the
 * interface counts down with, and this is what an administrator hands out.
 * test/tiers.test.mjs reads all three and fails if they disagree, which is the
 * only thing that keeps three copies of a number honest.
 */
export const TRIAL_DAYS = 30;

/**
 * Read a request body into an instruction, or into a refusal.
 *
 * Every refusal names what is wrong rather than returning a bare false: these
 * come back to a person in a toast, and "no" with no reason sends somebody to
 * the function logs for something the request could have said.
 *
 * @returns {{ok: true, action: string, email?: string, userId?: string, until?: string|null}
 *          | {ok: false, status: number, error: string}}
 */
export function readRequest(body, { caller = '' } = {}) {
  const action = String(body?.action || '').trim();
  if (!ACTIONS.includes(action)) {
    return { ok: false, status: 400, error: `Unknown action ${action || '(none)'}.` };
  }

  if (action === 'list') return { ok: true, action };

  if (action === 'invite') {
    const email = String(body?.email || '').trim().toLowerCase();
    // Deliberately shallow: the address is about to be handed to Supabase,
    // which is the thing that actually knows what it will accept. This only
    // catches the empty field and the obvious typo before a round trip.
    if (!email || !email.includes('@') || /\s/.test(email)) {
      return { ok: false, status: 400, error: 'That does not look like an email address.' };
    }
    return { ok: true, action, email };
  }

  const userId = String(body?.userId || '').trim();
  if (!userId) return { ok: false, status: 400, error: 'Which account?' };

  if (action === 'setPlan') {
    const plan = String(body?.plan || '').trim();
    /*
     * Named, and refused rather than defaulted.
     *
     * A misspelled plan that fell through to a default would be this tool
     * quietly doing something to an account nobody asked for - and the two
     * directions it could default in are "take Premium away" and "hand
     * Premium out", which are the two things worth never doing by accident.
     */
    if (!PLANS.includes(plan)) {
      return {
        ok: false,
        status: 400,
        error: `${plan || '(none)'} is not a plan. It is one of: ${PLANS.join(', ')}.`,
      };
    }
    const until = body?.until ? String(body.until) : null;
    if (until && Number.isNaN(Date.parse(until))) {
      return { ok: false, status: 400, error: 'That expiry is not a date.' };
    }
    return { ok: true, action, userId, plan, until };
  }

  /*
   * Deleting asks for the address to be typed, and the check is here rather
   * than only in the page.
   *
   * A confirmation that lives in the browser is a confirmation somebody can
   * skip by calling the endpoint directly, which is the one request in this
   * file that cannot be taken back. The page asks for the address; this
   * refuses unless what was typed is the address of the account being deleted.
   */
  const email = String(body?.email || '').trim().toLowerCase();
  const confirm = String(body?.confirm || '').trim().toLowerCase();
  if (!email) return { ok: false, status: 400, error: 'Which account?' };
  if (confirm !== email) {
    return { ok: false, status: 400, error: 'Type the account’s email address to confirm.' };
  }
  /*
   * And not your own, from here.
   *
   * Deleting the administrator's account through the administrator's tool
   * locks the tool. Closing your own account is a real thing to want and it
   * has its own path, in the account page, where the consequences are the
   * subject rather than a side effect.
   */
  if (email === String(caller || '').trim().toLowerCase()) {
    return { ok: false, status: 400, error: 'Close your own account from the account page, not here.' };
  }
  return { ok: true, action, userId, email };
}

/**
 * Whether an entitlement is this tool's to change.
 *
 * Only the ones granted by hand. A Stripe row is a mirror of a subscription
 * that is still running: revoking it here takes access away while the customer
 * keeps paying, and granting over it would be overwritten by the next webhook
 * anyway. The same goes for the App Store, which nothing here can cancel.
 */
export function mayChange(source) {
  return !source || source === 'granted' || source === 'comp' || source === 'trial';
}

/**
 * The entitlement row a chosen plan means, or null for "there should not be
 * one".
 *
 * Separated from the function that writes it so the decision can be tested
 * without a database, which is the same reason everything else in this file is
 * here. The interesting parts are the two nulls and they mean opposite things:
 * a null return is Free, which is the absence of a row, while a null
 * `expires_at` on a returned row is Premium that does not end.
 *
 * Free is the absence of a row rather than a row saying free. my_plan() reads
 * a missing row and an expired one the same way, and the absent one cannot be
 * misread later as "this account once paid".
 *
 * @param {string} plan  one of PLANS
 * @param {object} opts
 * @param {string|null} opts.until  an end date, if one was asked for
 * @param {number} opts.now         for tests
 * @param {string} opts.by          who is doing this, for the note
 */
export function planRow(plan, { until = null, now = Date.now(), by = '' } = {}) {
  if (plan === 'free') return null;

  if (plan === 'trial') {
    /*
     * A trial always ends, and that is what distinguishes it from a grant.
     * A trial with no end date would be Premium wearing the word Trial, and
     * every countdown in the app would have nothing to count.
     */
    const ends = until ? Date.parse(until) : now + TRIAL_DAYS * 86400000;
    return {
      tier: 'premium',
      source: 'trial',
      expires_at: new Date(ends).toISOString(),
      renews: false,
      note: `Trial set by ${by}`,
    };
  }

  return {
    tier: 'premium',
    source: 'granted',
    // Null means it does not expire, which is the ordinary case for a grant.
    expires_at: until,
    // A grant does not bill again, so it ends rather than renews. The panel
    // reads this to decide which word it puts in front of the date.
    renews: false,
    note: `Granted by ${by}`,
  };
}

/** What to say when it is not. */
export function whyNot(source) {
  if (source === 'stripe') return 'That account subscribes through Stripe. Cancel it in Stripe, not here.';
  if (source === 'appstore') return 'That account subscribes through the App Store. Only Apple can end it.';
  return `That entitlement came from ${source}, so it is not this tool's to change.`;
}

/**
 * One row of the list, from the places an account's state actually lives.
 *
 * Assembled here so the shape is testable without a database: the auth record,
 * the entitlement if there is one, how many folders the account holds, and
 * whether its free month has been spent.
 *
 * NOTHING IS COMPUTED FROM THE SIGNUP DATE ANY MORE
 *
 * It used to work out a trial from `created_at` - thirty days after the day
 * the account was made - because that was how the trial worked. It is a row
 * now, so this reads the row. The difference is visible in the list: an
 * account that signed up last week and never started a trial reads Free, which
 * is what it is, rather than Premium-until-a-date it was never offered.
 */
export function describeAccount(user, entitlement, folders = 0, { now = Date.now(), trialUsed = false } = {}) {
  const expires = entitlement?.expires_at ? Date.parse(entitlement.expires_at) : null;
  // An expired row is not a plan. my_plan() ignores one, and this list has to
  // agree with it or the interface reports access somebody does not have.
  const entitled = Boolean(entitlement)
    && entitlement.tier === 'premium'
    && (expires === null || expires > now);
  const source = entitled ? (entitlement.source || 'granted') : 'none';

  return {
    id: user?.id || '',
    email: user?.email || '',
    created: user?.created_at || null,
    confirmed: Boolean(user?.email_confirmed_at),
    provider: user?.app_metadata?.provider || 'email',
    lastSignIn: user?.last_sign_in_at || null,
    folders,
    /*
     * What they have, and where it came from. A trial is reported as a trial
     * rather than as Premium: it is the one state with a clock on it, and the
     * list is the place somebody decides whether to change anything.
     */
    plan: entitled ? (source === 'trial' ? 'trial' : 'premium') : 'free',
    source,
    until: entitled ? entitlement.expires_at : null,
    renews: entitled ? entitlement.renews !== false : false,
    changeable: entitled ? mayChange(entitlement.source) : true,
    /*
     * Whether the free month is spent, which the plan does not say.
     *
     * Free-with-a-trial-still-to-take and Free-with-one-already-used are the
     * same plan, and they are different situations to be looking at: the
     * second is somebody who tried Halfstop and decided not to pay.
     */
    trialUsed: Boolean(trialUsed),
  };
}
