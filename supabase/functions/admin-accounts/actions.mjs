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
export const ACTIONS = ['list', 'invite', 'grant', 'revoke', 'delete'];

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

  if (action === 'grant') {
    const until = body?.until ? String(body.until) : null;
    if (until && Number.isNaN(Date.parse(until))) {
      return { ok: false, status: 400, error: 'That expiry is not a date.' };
    }
    return { ok: true, action, userId, until };
  }

  if (action === 'revoke') return { ok: true, action, userId };

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
  return !source || source === 'granted' || source === 'comp';
}

/** What to say when it is not. */
export function whyNot(source) {
  if (source === 'stripe') return 'That account subscribes through Stripe. Cancel it in Stripe, not here.';
  if (source === 'appstore') return 'That account subscribes through the App Store. Only Apple can end it.';
  return `That entitlement came from ${source}, so it is not this tool's to change.`;
}

/**
 * One row of the list, from the three places an account's state actually lives.
 *
 * Assembled here so the shape is testable without a database: the auth record,
 * the entitlement if there is one, and how many folders the account holds.
 */
export function describeAccount(user, entitlement, folders = 0, { now = Date.now(), trialDays = 30 } = {}) {
  const created = user?.created_at ? Date.parse(user.created_at) : NaN;
  const trialEnds = Number.isFinite(created) ? created + trialDays * 86400000 : NaN;
  const expires = entitlement?.expires_at ? Date.parse(entitlement.expires_at) : null;
  const entitled = Boolean(entitlement)
    && entitlement.tier === 'premium'
    && (expires === null || expires > now);

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
     * list is the place somebody decides whether to grant anything.
     */
    plan: entitled ? 'premium' : (Number.isFinite(trialEnds) && trialEnds > now ? 'trial' : 'free'),
    source: entitled ? (entitlement.source || 'granted') : (Number.isFinite(trialEnds) && trialEnds > now ? 'trial' : 'none'),
    until: entitled ? entitlement.expires_at : (Number.isFinite(trialEnds) && trialEnds > now ? new Date(trialEnds).toISOString() : null),
    renews: entitled ? entitlement.renews !== false : false,
    changeable: entitled ? mayChange(entitlement.source) : true,
  };
}
