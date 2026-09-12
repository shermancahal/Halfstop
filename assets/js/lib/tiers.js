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
 * How long a new account gets everything.
 *
 * Stated here as well as in the database because the interface counts down
 * with it. The database is the one that decides; this is the one that can be
 * wrong without anybody losing access, which is the right way round.
 */
export const TRIAL_DAYS = 30;

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
  if (!billing.live) return TIERS[DEFAULT_TIER];
  const id = account?.plan?.tier;
  return TIERS[id] || TIERS[DEFAULT_TIER];
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
 * How somebody would get Premium, if they could.
 *
 * Three answers and they are genuinely different, so the interface should not
 * have to guess from a boolean: nothing is for sale, it is sold through the
 * App Store, or this build does not know. Returned as a shape rather than a
 * sentence so the panel can decide what to draw.
 */
export function purchaseRoute({ billing = BILLING } = {}) {
  if (!billing.live) return { available: false, why: 'not-live' };
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
  // Every account has everything, so a countdown would count down to nothing
  // happening.
  if (!billing.live) return '';
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
    name: tier.name,
    note: tier.note,
    /* Where the entitlement came from: 'trial', 'granted', 'appstore', 'none'. */
    source: plan?.source || 'none',
    until: plan?.until || null,
    /* The same thing as a sentence, which is what the menu actually shows. */
    line: describePlan(plan, { billing }),
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
