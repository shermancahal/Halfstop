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
 * turning `BILLING.live` on and writing the server-side half — not finding
 * every call site.
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
    grants: [],
    note: 'Everything is free while Halfstop is being built. '
      + 'If that ever changes, it will change here first and it will say so.',
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    grants: Object.keys(FEATURES),
    note: 'The metered parts: searching, syncing, weather, offline downloads, '
      + 'routing, photographs on a pin and the state maps.',
  },
};

export const DEFAULT_TIER = 'free';

/** The tier a reader is on. One today, and the signature is ready for more. */
export function tierFor(account = null, { billing = BILLING } = {}) {
  if (!billing.live) return TIERS[DEFAULT_TIER];
  /*
   * Deliberately not reading a claim out of the session yet.
   *
   * When this does read one it must come from a signed token the server issued,
   * not from a field the client can set — and writing the client-side half
   * first is how a plan field ends up in localStorage and treated as true.
   */
  const id = account?.tier;
  return TIERS[id] || TIERS[DEFAULT_TIER];
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
  return {
    tier,
    name: tier.name,
    note: tier.note,
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
