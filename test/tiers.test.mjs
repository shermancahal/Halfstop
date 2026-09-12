import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURES, TIERS, DEFAULT_TIER, tierFor, can, gateReason, planSummary, describePlan, daysLeft, featureForLayer,
} from '../assets/js/lib/tiers.js';

const FREE = { live: false };
const LIVE = { live: true };

/*
 * The state of the project, asserted rather than described.
 *
 * "Everything is free for now" is a claim in a README until something checks
 * it. If a gate is ever closed by accident — a feature dropped out of the free
 * tier's grants, or the flag flipped in a commit that was about something else
 * — this is what says so.
 */
test('tiers: today, every feature is offered to everybody', () => {
  for (const feature of Object.keys(FEATURES)) {
    assert.equal(can(feature, { billing: FREE }), true, `${feature} should be free`);
  }
});

test('tiers: the plans are drawn where the website says they are', async () => {
  /*
   * Read off the page rather than restated here.
   *
   * This used to assert that Free granted nothing, which described the split
   * without checking it: the matrix and the website are two lists of the same
   * decision, kept in different files, and the comment claiming they agreed
   * was the only thing holding them together. Moving one feature between
   * tiers touches both, and forgetting either is silent.
   *
   * The day BILLING.live goes on, this matrix is what closes. One that
   * disagreed with the page would take somebody's money for something the
   * page told them they already had.
   */
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const card = (heading) => page.split(`<h3>${heading}</h3>`)[1]?.split('</div>')[0] || '';
  const free = card('Free Tier');
  const premium = card('Premium Tier');
  assert.ok(free && premium, 'the costs section still has both cards');

  for (const [key, text] of Object.entries(FEATURES)) {
    const onFree = free.includes(text);
    const onPremium = premium.includes(text);
    assert.equal(onFree || onPremium, true, `the page never mentions ${key}`);
    assert.equal(onFree && onPremium, false, `the page lists ${key} under both tiers`);
    assert.equal(TIERS.free.grants.includes(key), onFree,
      `the matrix and the page disagree about ${key}`);
  }

  // Premium is still everything: a feature that fell out of it would be one
  // nobody could buy.
  assert.deepEqual(TIERS.premium.grants.slice().sort(), Object.keys(FEATURES).sort());
});

test('tiers: the keys the app still asks for reach the feature that replaced them', () => {
  /*
   * roadRoute and rvRouting are one purchase now, and the trip planner and the
   * RV form still ask for them by their old names. An alias that stopped
   * resolving would answer false and close a gate nobody meant to close - so
   * the closed world is where this is checked.
   */
  const premium = TIERS.premium;
  for (const [asked, means] of [['roadRoute', 'tripRouting'], ['rvRouting', 'tripRouting'],
    ['fogForecast', 'weatherLayers'], ['offlineRegions', 'offlineDownloads']]) {
    assert.equal(can(asked, { tier: premium, billing: LIVE }), true, `${asked} should reach ${means}`);
    assert.equal(can(asked, { tier: TIERS.free, billing: LIVE }), false, `${asked} should be gated on Free`);
    assert.match(gateReason(asked), new RegExp(FEATURES[means].split(' ')[0], 'i'));
  }
});

/*
 * The flag has to actually be load-bearing. A `can()` that returned true
 * whatever the flag said would pass the test above and be scaffolding that
 * holds nothing up — so the closed world is exercised too, against a tier that
 * grants one feature.
 */
test('tiers: with billing live, the matrix is what decides', () => {
  const limited = { id: 'trial', name: 'Trial', grants: ['weatherLayers'], note: '' };
  assert.equal(can('weatherLayers', { tier: limited, billing: LIVE }), true);
  assert.equal(can('tripRouting', { tier: limited, billing: LIVE }), false);
  // And the same call with billing off is open again, so the flag is the switch.
  assert.equal(can('tripRouting', { tier: limited, billing: FREE }), true);
});

test('tiers: a feature nobody has heard of is not quietly allowed', () => {
  assert.equal(can('teleportation', { billing: FREE }), false);
  assert.equal(can('', { billing: FREE }), false);
  assert.equal(can(undefined, { billing: LIVE }), false);
});

/*
 * Prototype pollution is the boring way a permission check goes wrong: without
 * hasOwn, `can('toString')` is true because every object has one.
 */
test('tiers: an inherited property is not a feature', () => {
  assert.equal(can('toString', { billing: LIVE }), false);
  assert.equal(can('constructor', { billing: LIVE }), false);
});

test('tiers: everyone is on the free plan until there is a server saying otherwise', () => {
  assert.equal(tierFor(null).id, DEFAULT_TIER);
  assert.equal(tierFor({ tier: 'enterprise' }).id, DEFAULT_TIER);
  // Even with billing live, an unknown plan falls back rather than failing open
  // into some other tier's grants.
  assert.equal(tierFor({ tier: 'enterprise' }, { billing: LIVE }).id, DEFAULT_TIER);
});

/*
 * A gate that says only "not on your plan" makes the reader guess what they
 * lost. The sentence has to name the thing they were trying to do, so they can
 * check it against what they pressed.
 */
test('tiers: a refusal names the feature, not just the plan', () => {
  const said = gateReason('rvRouting');
  assert.match(said, /Trip routing/);
  assert.match(said, /Free/);
  assert.match(gateReason('nonsense'), /not something this app does/);
});

test('tiers: the plan summary says both what you have and whether it is real yet', () => {
  const summary = planSummary(null, { billing: FREE });
  assert.equal(summary.name, 'Free');
  assert.equal(summary.live, false);
  // Everything, because that is what an account gets while billing is off -
  // not the empty list Free grants for the day it is on.
  assert.equal(summary.includes.length, Object.keys(FEATURES).length);
  assert.match(summary.note, /free while Halfstop is being built/);

  // And once it is real, the plan the server answered with is what decides.
  const paying = planSummary({ plan: { tier: 'premium', source: 'granted' } }, { billing: LIVE });
  assert.equal(paying.name, 'Premium');
  assert.equal(paying.includes.length, Object.keys(FEATURES).length);
  // Free is no longer empty: place search is metered and given away anyway.
  assert.deepEqual(
    planSummary(null, { billing: LIVE }).includes,
    [FEATURES.placeSearch],
  );
});

/* ------------------------------------------------------- the trial */

const DAY = 86400000;
const LIVE_NOW = 1789000000000;

test('tiers: a tier set on the account itself is not a plan', () => {
  // The shape matters. A plan arrives from the server under `plan`; a bare
  // `tier` is the shape a browser could invent for itself, and reading it
  // would be this module deciding what it is documented not to decide.
  assert.equal(tierFor({ tier: 'premium' }, { billing: LIVE }).name, 'Free');
  assert.equal(tierFor({ plan: { tier: 'premium' } }, { billing: LIVE }).name, 'Premium');
});

test('tiers: the trial counts down in days a person can check', () => {
  const trial = (days) => ({
    tier: 'premium',
    source: 'trial',
    until: new Date(LIVE_NOW + days * DAY).toISOString(),
  });

  const say = (plan) => describePlan(plan, { now: LIVE_NOW, billing: LIVE });
  assert.equal(say(trial(9)), 'Trial, 9 days left.');
  assert.equal(say(trial(1)), 'Trial, 1 day left.', 'not "1 days"');
  // Rounded up, so the last afternoon of a trial does not read as zero.
  assert.equal(say(trial(0.25)), 'Trial, 1 day left.');
  assert.equal(say(trial(-1)), 'Trial ends today.');
});

test('tiers: a paid plan with an end date counts down without the word trial', () => {
  const ends = new Date(LIVE_NOW + 5 * DAY).toISOString();
  assert.equal(
    describePlan({ tier: 'premium', source: 'appstore', until: ends }, { now: LIVE_NOW, billing: LIVE }),
    '5 days left.',
  );
});

test('tiers: the line never repeats what the name above it says', () => {
  // The plan's name is already on screen. "Free." written under the word Free
  // is the line the one-word decision exists to prevent.
  const say = (plan) => describePlan(plan, { now: LIVE_NOW, billing: LIVE });
  assert.equal(say(null), '');
  assert.equal(say({ tier: 'free', source: 'none', until: null }), '');
  assert.equal(say({ tier: 'premium', source: 'granted', until: null }), '');
});

test('tiers: nothing is said about a trial while there is nothing to lose', () => {
  /*
   * Billing is off, so every account has everything and a countdown would be
   * counting down to nothing happening.
   *
   * Empty rather than a reassuring sentence, because the menu shows the plan
   * as one word and nothing under it by an earlier decision that the smoke
   * test guards: the explaining belongs in the FAQ rather than somewhere
   * somebody opened to change their units.
   */
  assert.equal(
    describePlan({ tier: 'premium', source: 'trial', until: new Date(LIVE_NOW).toISOString() }, { billing: FREE }),
    '',
  );
});

test('tiers: a plan nobody has answered with yet is not premium', () => {
  // Null means the question has not been asked, which must not read as a grant.
  assert.equal(tierFor({ plan: null }, { billing: LIVE }).name, 'Free');
  assert.equal(daysLeft(null), null);
  assert.equal(daysLeft('not a date'), null);
});

/*
 * The warning that makes the rest of it safe. This module runs on the reader's
 * computer, so a future change that turned it into the actual check has to trip
 * over something — and a comment nothing reads is not something.
 */
test('tiers: the module says out loud that it is not a permission boundary', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../assets/js/lib/tiers.js', import.meta.url), 'utf8');
  assert.match(source, /NOT A PERMISSION BOUNDARY/);
  assert.match(source, /Supabase/);
  assert.match(source, /devtools/);
});

test('tiers: the shipped default really is everything-free', async () => {
  const { BILLING } = await import('../assets/js/config.js');
  assert.equal(BILLING.live, false);
});

/* --------------------------------------------- every paid feature is wired */

/*
 * The failure this catches, which happened.
 *
 * Seven features were listed as Premium on the website and exactly one of them
 * was gated anywhere in the app: can() appeared three times, all routing.
 * Switching BILLING.live on would have produced a paid tier where six of seven
 * items kept working and one showed an error toast, and nothing anywhere would
 * have said so - not a test, not a type, not a lint.
 *
 * So this asks the app rather than trusting it: for every feature the free
 * tier does not grant, something has to gate it. Either a can() call naming it
 * or one of its aliases, or a real layer in the catalogue that featureForLayer
 * assigns to it.
 *
 * It does not check that the gate works, only that one exists. Whether it
 * holds is the server's job, and the server does not read a plan yet.
 */
test('tiers: every feature the free tier does not grant is gated somewhere', async () => {
  const { readFile } = await import('node:fs/promises');
  const { BASEMAPS, OVERLAYS } = await import('../assets/js/config.js');

  const sources = await Promise.all(['../assets/js/viewer.js', '../assets/js/lib/account.js']
    .map((file) => readFile(new URL(file, import.meta.url), 'utf8')));

  // Feature keys named in a can() call anywhere in the app, aliases resolved
  // the way can() itself resolves them.
  const gated = new Set();
  for (const source of sources) {
    for (const [, named] of source.matchAll(/\bcan\('([a-zA-Z]+)'\)/g)) {
      // can() maps the old names onto the feature that replaced them, so a
      // call using one still counts as gating the real feature.
      const key = Object.keys(FEATURES).find((feature) => can(named, {
        billing: LIVE,
        tier: { id: 't', name: 'T', grants: [feature], note: '' },
      }));
      if (key) gated.add(key);
    }
  }

  // And the layers, which are gated by what they are rather than by a call.
  for (const layer of [...BASEMAPS, ...OVERLAYS]) {
    const needs = featureForLayer(layer);
    if (needs) gated.add(needs);
  }

  for (const key of Object.keys(FEATURES)) {
    if (TIERS.free.grants.includes(key)) continue;
    assert.equal(gated.has(key), true,
      `${key} is sold as Premium and nothing in the app gates it`);
  }
});

test('tiers: the layers a plan covers are decided by what the layer already is', async () => {
  const { OVERLAYS } = await import('../assets/js/config.js');
  const weather = OVERLAYS.filter((l) => featureForLayer(l) === 'weatherLayers');
  const state = OVERLAYS.filter((l) => featureForLayer(l) === 'stateLayers');

  // Real counts rather than "more than zero": a mapping that quietly stopped
  // matching would still pass that, and the whole group would go free.
  assert.equal(weather.length > 0, true, 'the weather group still maps to weatherLayers');
  assert.equal(state.length > 0, true, 'layers carrying states still map to stateLayers');
  assert.equal(weather.every((l) => l.group === 'Weather'), true);
  assert.equal(state.every((l) => l.states?.length > 0), true);
  // Nothing is in both, which would make one of them unreachable.
  assert.equal(weather.some((l) => state.includes(l)), false);
});
