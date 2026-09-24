/**
 * What a plan includes — scaffolding, with every gate open.
 *
 * NOT A PERMISSION BOUNDARY. Read that first and take it literally. This module
 * decides what the browser offers, and the browser is the reader's computer:
 * anybody can set their tier to whatever they like in devtools in about four
 * seconds. It is exactly the same kind of thing as `SITE.editors` — a
 * convenience for drawing the interface, not a check.
 *
 * Anything that actually costs money has to be enforced where the money is
 * spent, which is somewhere this code cannot reach:
 *
 *   - Folder sync is enforced by the row-level policy on the Supabase table,
 *     which reads the signed-in user's own claim server-side.
 *   - Road routing and RV routing will be enforced at whatever proxy ends up
 *     in front of Valhalla, because that is the thing with a bill attached.
 *     Today they go straight to a public community server under its own rate
 *     limit, so there is nothing to enforce and nothing pretending to.
 *   - Tile downloads are enforced by whoever serves the tiles.
 *
 * WHY IT EXISTS NOW, WITH NOTHING GATED
 *
 * Because the alternative is discovering later that the decision "is this
 * reader allowed to do this" is spelled eleven different ways in eleven places.
 * One list, one function, one flag. When a tier does launch, the work is
 * turning `BILLING.live` on and writing the server-side half, not finding every
 * call site.
 *
 * WHERE THE ENTITLEMENT IS EXPECTED TO COME FROM
 *
 * An App Store subscription, which means it arrives as a claim this code reads
 * and cannot write: Apple tells a server, the server sets the claim, the client
 * is told. It does not arrive as a receipt the app hands up, because a receipt
 * the app can hand up is a string the app can invent, and renewals and
 * cancellations happen when nobody has the app open.
 *
 * That decision is worth knowing here because it rules something out. Do not
 * build a web checkout against this module: in-app purchase only exists inside
 * a shipped native app, so billing cannot go live before that app does.
 * `docs/mobile-app.md` has the staging and what the commission actually is.
 *
 * `EVERYTHING` is the honest state today: a free tier that includes all of it.
 * The matrix below is a plan, not a promise, and nothing in the app reads it
 * for anything other than what to say when asked.
 */

import { BILLING } from '../config.js';
import { appShell } from './native-shell.js';

/**
 * The things a plan could be about.
 *
 * Named for what the reader does, not for what it costs us. `roadRoute` rather
 * than `valhallaRequest`, because the day the router changes the feature has
 * not, and a feature name that leaks the vendor is a rename waiting to happen.
 */
export const FEATURES = {
  placeSearch: 'Searching for a place by name',
  folderSync: 'Syncing between devices',
  weatherLayers: 'Weather layers',
  offlineDownloads: 'Offline downloads',
  tripRouting: 'Trip routing',
  pinPhotos: 'Photographs attached to a waypoint',
  stateLayers: 'State level detail maps',
  extraBasemaps: 'Extra basemaps',
};

/*
 * Two names the app still asks for, mapped onto the one that replaced them.
 *
 * The trip planner asks `can('roadRoute')` and the RV form asks
 * `can('rvRouting')`, and both are now the same purchase. Aliased rather than
 * renamed at the call sites so a stale key cannot silently answer false and
 * close a gate nobody meant to close.
 */
const ALIASES = {
  roadRoute: 'tripRouting',
  rvRouting: 'tripRouting',
  fogForecast: 'weatherLayers',
  offlineRegions: 'offlineDownloads',
};

/** The feature a key means, following an alias where there is one. */
function resolve(feature) {
  return ALIASES[feature] || feature;
}

/**
 * Two plans, drawn where the website says they are drawn.
 *
 * Free grants none of the metered features and Premium grants all of them,
 * which is the split on the What it costs section rather than a second opinion
 * about it. That matters more than it sounds: the day BILLING.live is turned
 * on, these lists are what closes, and a matrix that disagreed with the page
 * would take somebody's money for something they already had.
 *
 * Nothing is gated today. `can()` returns true for everything while billing is
 * off, so every account behaves as Premium and the free plan's empty grants
 * are a description of the future rather than of now.
 */
export const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    /*
     * Place search is metered and free anyway, deliberately.
     *
     * It is the first thing anybody does with a map, and a map you cannot
     * search is a map you have to already know. At this size the bill for it
     * is small enough to carry, and meeting somebody with a locked search box
     * in their first minute costs more than the requests do.
     */
    grants: ['placeSearch'],
    note: 'Everything is free while Halfstop is being built. '
      + 'If that ever changes, it will change here first and it will say so.',
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    grants: Object.keys(FEATURES),
    note: 'The metered parts: syncing, weather, offline downloads, routing, '
      + 'photographs on a pin and the state maps.',
  },
};

export const DEFAULT_TIER = 'free';

/**
 * How long a trial runs, for the sentence that offers one.
 *
 * Stated here as well as in the database because the interface says the number
 * out loud before anybody has a trial to count down - "Try Premium free for 30
 * days" is written before public.start_trial() has been called and therefore
 * before there is a date to read. The database is the one that decides; this
 * is the one that can be wrong without anybody losing access, which is the
 * right way round. test/tiers.test.mjs checks the two against each other.
 */
export const TRIAL_DAYS = 30;

/**
 * Where an entitlement came from, when it came from somewhere real.
 *
 * A trial is not one of these, and neither is 'none'. Both mean "has not
 * bought anything", which while billing is off is what everybody is. That the
 * trial is missing from this list is the thing that lets somebody subscribe
 * during their free month rather than having to wait for it to run out, so it
 * is an omission on purpose rather than one to tidy up.
 *
 * 'comp' is here, which looks like the odd one out: nobody paid for it. But
 * this list is read to decide whether to offer somebody a purchase, and a
 * comped account has been given the thing the purchase would buy. Offering to
 * sell it to them would be asking for money for what they were handed.
 *
 * A list of what counts as settled rather than a list of what does not, with
 * anything unrecognised falling through to being offered a purchase. That way
 * round on purpose: a source nobody taught this about means at worst a button
 * somebody presses and the checkout refuses with "you already subscribe",
 * which is visible and harmless, while the other way round means a free
 * account that is silently never shown a way to pay.
 */
const SETTLED = new Set(['granted', 'stripe', 'appstore', 'play', 'comp']);

/**
 * The tier a reader is on.
 *
 * The plan is not computed here and never should be. It is read from the
 * server by `public.my_plan()`, which knows two things this file cannot: when
 * the account was created, and whether anybody granted it anything. What
 * arrives is an answer, not evidence, and it is still only used to decide what
 * to draw.
 */
export function tierFor(account = null, { billing = BILLING } = {}) {
  const plan = account?.plan || null;
  /*
   * Flattened to Free while billing is off - unless somebody actually holds
   * something.
   *
   * The flattening is right for almost everybody: every feature is open to
   * everybody, so naming a tier would describe a restriction that does not
   * exist. But it also hid the one thing a test purchase is for. Paying with
   * 4242 4242 4242 4242 writes a real entitlement row, and the panel above it
   * went on saying Free - which looks exactly like the webhook never arriving,
   * and sends somebody to read function logs to tell the two apart.
   *
   * So a settled source is named. This says what somebody has, not what they
   * may do: `includes` below still reports every feature while billing is off,
   * because that is still true, and nothing outside this file gates on a tier
   * anyway - the header of this module says why.
   */
  if (!billing.live && !SETTLED.has(plan?.source)) return TIERS[DEFAULT_TIER];
  return TIERS[plan?.tier] || TIERS[DEFAULT_TIER];
}

/** Sources that bill again when the period ends, rather than simply running out. */
const RENEWING = new Set(['stripe', 'appstore', 'play']);

/**
 * The date on the plan, and what that date means.
 *
 * A cancelled subscription and a healthy one carry the same field: Stripe
 * reports both as active until the period actually runs out, and the entitlement
 * row holds the same end date for each. So the date alone is not an answer —
 * "October 13" is a renewal to one reader and the last day to another, and
 * showing it without saying which is how somebody reads a cancellation into a
 * subscription that is fine, or the reverse.
 *
 * `renews` comes from the webhook, which reads `cancel_at_period_end`. Missing
 * reads as renewing for a subscription, because wrongly promising a renewal is
 * a smaller wrong than wrongly announcing an ending.
 *
 * Written as a date rather than a countdown. "25 days left" is the right shape
 * for a trial, where the clock is the point; somebody who has just cancelled
 * wants the day their access stops, and wants to be able to check it against
 * what the billing portal told them.
 *
 * @param timeZone only for tests — left unset, the date is the reader's own,
 *        which matters because a period ending at 03:25 UTC is the previous
 *        evening across the whole country this app is drawn for.
 */
export function describeRenewal(plan = null, { billing = BILLING, timeZone = '' } = {}) {
  if (!billing.live && !SETTLED.has(plan?.source)) return '';
  if (plan?.tier !== 'premium') return '';
  if (!plan.until) return '';

  const when = new Date(plan.until);
  if (Number.isNaN(when.getTime())) return '';
  const date = when.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}),
  });

  if (plan.source === 'trial') return `Trial ends ${date}.`;
  const renews = RENEWING.has(plan.source) && plan.renews !== false;
  return renews ? `Renews ${date}.` : `Ends ${date}.`;
}

/** Whole days left, rounded up, so the last day reads as "1" and not "0". */
export function daysLeft(until, { now = Date.now() } = {}) {
  const ends = until ? Date.parse(until) : NaN;
  if (!Number.isFinite(ends)) return null;
  return Math.max(0, Math.ceil((ends - now) / 86400000));
}

/**
 * What Premium adds over Free, in the reader's words.
 *
 * The difference rather than the whole list, because somebody looking at an
 * upgrade wants to know what changes. Computed from the two tiers rather than
 * written out again: place search moved between them once already, and a
 * hand-kept third copy is the one that would have been missed.
 */
export function premiumAdds() {
  const free = new Set(TIERS.free.grants);
  return TIERS.premium.grants
    .filter((key) => !free.has(key))
    .map((key) => FEATURES[key])
    .filter(Boolean);
}

/** Money, the way a person writes it: no trailing zeros on a whole number. */
function money(cents) {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** The plans on offer, in the order they should be read. */
export function plansOffered({ billing = BILLING } = {}) {
  return Object.entries(billing.plans || {}).map(([id, plan]) => ({ id, ...plan }));
}

/**
 * The price, written the way a person writes it.
 *
 * Named by plan rather than by index, so a caller asks for the year and gets
 * the year even if the order changes.
 */
export function describePrice({ plan = null, billing = BILLING } = {}) {
  const key = plan || billing.defaultPlan || 'month';
  const chosen = billing.plans?.[key];
  const cents = Number(chosen?.price);
  if (!Number.isFinite(cents) || cents <= 0) return '';
  return `${money(cents)} a ${chosen.period || key}`;
}

/**
 * What paying for the year saves, worked out rather than asserted.
 *
 * "Two months free" is the sentence everybody reaches for and it is usually a
 * lie by a few dollars: at $4.99 and $49 the year costs a shade under ten
 * months, not ten exactly. Computing it means the page cannot drift from the
 * prices above it, and cannot overstate the discount by rounding in our own
 * favour.
 *
 * Null when there is nothing to compare, so a caller can leave it out rather
 * than print "saves $0".
 */
export function annualSaving({ billing = BILLING } = {}) {
  const month = Number(billing.plans?.month?.price);
  const year = Number(billing.plans?.year?.price);
  if (!Number.isFinite(month) || !Number.isFinite(year) || month <= 0 || year <= 0) return null;

  const twelve = month * 12;
  if (year >= twelve) return null;

  const saved = twelve - year;
  return {
    cents: saved,
    money: money(saved),
    percent: Math.round((saved / twelve) * 100),
  };
}

/**
 * Whether this account may see the purchase panel before billing is live.
 *
 * Presentation, and only that: it decides whether a button is drawn. Who may
 * actually pay is decided by the Edge Function against its own list, because
 * this one runs on the reader's computer and they can edit it.
 */
export function isBillingTester(user, { billing = BILLING } = {}) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return false;
  return (billing.testers || []).includes(email);
}

/**
 * Whether to show somebody how to start paying.
 *
 * A trial counts as not paying yet, which is the whole point of this
 * function existing. A trial reads as premium everywhere else - correctly,
 * because everything works - and reading it that way here meant nobody could
 * subscribe during their first thirty days: they would have had to let the
 * trial lapse, lose it all, and only then be offered the thing that would have
 * kept it. Backwards, and invisible, because the person it happened to would
 * simply not see a button.
 */
export function offersUpgrade(summary) {
  if (!summary?.live) return false;
  /*
   * Read off the source, never off the tier.
   *
   * `tierFor` flattens every account to Free while billing is off - correct
   * for the panel, because every feature is open to everybody and naming a
   * tier would describe a restriction that does not exist. But the test-mode
   * preview forces `live: true` onto a summary built with billing off, so a
   * check on `tier.id` saw Free for everybody and offered to sell Premium to
   * an account that already had it, including one already paying by card.
   *
   * The source is the one field that says the same thing either way, so it is
   * the one to ask.
   */
  return !SETTLED.has(summary.source);
}

/**
 * How somebody would get Premium, if they could.
 *
 * The answers are genuinely different, so the interface should not have to
 * guess from a boolean: nothing is for sale; it is sold here, by Stripe in a
 * browser or by Google Play in the Android app; it is sold only in the App
 * Store; or this build does not know. Returned as a shape rather than a
 * sentence so the panel can decide what to draw.
 */
export function purchaseRoute({ billing = BILLING, preview = false, shell = appShell() } = {}) {
  /*
   * `preview` is how the people who run this reach a checkout before billing
   * is live, to test one with a card that is not a card.
   *
   * It only decides what is drawn. The real control is in the checkout
   * function, which refuses anybody not named as a tester while the Stripe key
   * is a test key - because a hidden button is not a control, and that
   * function is reachable by anybody with a session whether or not the app
   * ever draws the button.
   */
  if (!billing.live && !preview) return { available: false, why: 'not-live' };

  /*
   * Inside the app, where it is running decides, and the build flag does not.
   *
   * Both stores require their own billing for a digital subscription sold in
   * an app, and `store` is the website's setting - a local token.js set to
   * 'stripe' for testing a checkout was, unchanged, an app bundle offering a
   * card form inside the web view. Asking the platform removes that trap
   * rather than warning about it.
   *
   * Android sells through Google Play. The iPhone app sells nothing yet:
   * StoreKit is not built, and "subscribe on the website" is the one sentence
   * Apple does not allow an app to say, so it says there is no way to
   * subscribe here - which is true.
   */
  if (shell.native) {
    if (shell.platform !== 'android') return { available: false, why: 'no-store' };
    return billing.live ? { available: true, where: 'play' } : { available: true, where: 'play', preview: true };
  }

  // Stripe is the only route a browser can complete, so it is the one a
  // preview means. There is nothing to test about sending somebody to Apple.
  if (!billing.live && preview) return { available: true, where: 'stripe', preview: true };
  // Stripe is the one a browser can actually complete. The App Store is the
  // one a browser cannot, so it is reported as a place rather than a button:
  // the panel sends people to the app instead of showing a control that
  // cannot work where they are standing.
  if (billing.store === 'stripe') return { available: true, where: 'stripe' };
  if (billing.store === 'appstore') return { available: false, why: 'in-app-only' };
  return { available: false, why: 'no-store' };
}

/**
 * What the plan's name does not already say.
 *
 * Empty most of the time, and that is correct. The menu shows the plan as one
 * word by an earlier decision the smoke test guards: the explaining belongs in
 * the FAQ rather than somewhere somebody opened to switch to Celsius, and
 * "Free." written under the word Free is the kind of line that decision exists
 * to prevent.
 *
 * So this carries the one thing a name cannot, which is when it stops. A trial
 * that does not say when it ends is a trial that ends as a surprise. It counts
 * rather than naming a date, because "9 days left" is checkable against a
 * calendar and a date on its own has to be worked out.
 */
export function describePlan(plan = null, { now = Date.now(), billing = BILLING } = {}) {
  /*
   * Every account has everything, so a countdown would count down to nothing
   * happening - unless this is something somebody bought, where the date is
   * the useful part.
   *
   * "30 days left" under Premium is how a test purchase shows it wrote a real
   * period end rather than the null that once meant Premium for ever.
   */
  if (!billing.live && !SETTLED.has(plan?.source)) return '';
  // The name says Free, and a plan that is not premium has no end to report.
  if (plan?.tier !== 'premium') return '';
  // Premium with no end date: the ordinary case for whoever runs the service,
  // and saying "until forever" about it would be worse than silence.
  if (!plan.until) return '';

  const left = daysLeft(plan.until, { now });
  if (left === null) return '';

  const trial = plan.source === 'trial';
  if (left === 0) return trial ? 'Trial ends today.' : 'Ends today.';
  const days = `${left} day${left === 1 ? '' : 's'} left`;
  return trial ? `Trial, ${days}.` : `${days[0].toUpperCase()}${days.slice(1)}.`;
}

/**
 * Which feature a map layer belongs to, or null if it is free.
 *
 * Derived from what the layer already says about itself rather than from a
 * flag added to seventy entries in config.js. The weather group is the weather
 * group, and a layer carrying `states` is one of the state level maps: both
 * are properties those layers have for their own reasons, so a new layer joins
 * the right tier by being what it is rather than by somebody remembering.
 *
 * The cost of that is a layer could join a paid tier by accident. It is the
 * better risk: the other way round, a layer silently escapes one.
 */
export function featureForLayer(entry) {
  if (!entry) return null;
  /*
   * A basemap says so itself, rather than being worked out from what it draws.
   *
   * This is the one place the derive-it-from-what-it-is rule above is the
   * wrong risk, and it is worth saying why. The property that makes the
   * Mapbox basemaps cost money is that they draw from Mapbox - so the obvious
   * derivation is "draws from Mapbox, therefore paid". But Byways Topo falls
   * back to Mapbox whenever there is no Protomaps archive configured, which
   * would put the default basemap behind the gate on any deploy that has not
   * cut one. The other rules can afford to over-include; this one would take
   * the map out from under a first-time reader.
   */
  if (entry.premium) return 'extraBasemaps';
  if (entry.group === 'Weather') return 'weatherLayers';
  if (Array.isArray(entry.states) && entry.states.length) return 'stateLayers';
  return null;
}

/**
 * Whether to offer a feature.
 *
 * "Offer", not "allow". A true here means draw the button; it does not mean the
 * request behind the button will be served, and nothing downstream should treat
 * it as though it does.
 */
export function can(feature, { tier = null, billing = BILLING } = {}) {
  const key = resolve(feature);
  if (!Object.hasOwn(FEATURES, key)) return false;
  // Every gate open until there is a server-side half to close it against.
  if (!billing.live) return true;
  const plan = tier || TIERS[DEFAULT_TIER];
  return plan.grants.includes(key);
}

/**
 * What to say when something is not included — never a bare "upgrade".
 *
 * A gate that says only "not on your plan" makes the reader guess what they
 * lost. This names the feature back to them so the sentence is checkable
 * against what they were trying to do.
 */
export function gateReason(feature, { tier = null } = {}) {
  const what = FEATURES[resolve(feature)];
  if (!what) return 'That is not something this app does.';
  const plan = tier || TIERS[DEFAULT_TIER];
  return `${what} is not included in ${plan.name}.`;
}

/**
 * The plan as a line to put in front of somebody, for the settings menu.
 *
 * Returned rather than rendered so the words are testable without a browser,
 * which is the only part of this that has ever been wrong.
 */
export function planSummary(account = null, { billing = BILLING } = {}) {
  const tier = tierFor(account, { billing });
  const plan = account?.plan || null;
  return {
    tier,
    /*
     * One word: Free, Trial, or Premium.
     *
     * The panel says what somebody is on and stops. It used to say the tier,
     * which called a trial "Premium" - true, since a trial grants everything,
     * and useless as a label: it made the one state with a clock on it
     * indistinguishable from the one without.
     *
     * Read off the source rather than the tier for that reason. The tier
     * answers what you may do; this answers what you are on, and they are the
     * same word in two cases out of three.
     */
    name: plan?.source === 'trial' ? 'Trial' : tier.name,
    note: tier.note,
    /* Where the entitlement came from: 'trial', 'granted', 'stripe', 'play', 'appstore', 'none'. */
    source: plan?.source || 'none',
    until: plan?.until || null,
    /*
     * Whether this account may still start its free month.
     *
     * Straight through from my_plan(), and not worked out here, because it is
     * not derivable from anything else on this object: Free with a trial still
     * to take and Free with one already spent are the same plan and different
     * offers. The server knows, because it holds the row saying the trial
     * happened; this file cannot, and should not guess from the plan.
     *
     * Absent reads as false. A build talking to a database that predates the
     * trials table gets no button, which is the harmless direction - the other
     * way round draws a control whose only outcome is an error.
     */
    trialAvailable: plan?.trialAvailable === true,
    /* The same thing as a sentence, which is what the upgrade panel shows. */
    line: describePlan(plan, { billing }),
    /* Whether the date below is a renewal or an ending; see describeRenewal. */
    renews: plan?.renews !== false,
    /* And that date said out loud, which is what the menu shows. */
    renewal: describeRenewal(plan, { billing }),
    /* Whether any of this is real yet, which the interface should not hide. */
    live: Boolean(billing.live),
    /*
     * What this account actually gets, which is not the same as what the plan
     * grants until billing is live.
     *
     * Free grants nothing metered, because that is the split the website
     * prints and the one that will close on the day there is something to buy.
     * Reading the grants today would tell somebody they have none of it while
     * they are using all of it.
     */
    includes: (billing.live ? tier.grants : Object.keys(FEATURES))
      .map((key) => FEATURES[key]).filter(Boolean),
  };
}
