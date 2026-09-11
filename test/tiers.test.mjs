import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURES, TIERS, DEFAULT_TIER, tierFor, can, gateReason, planSummary, describePlan, daysLeft,
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

test('tiers: the plans are drawn where the website says they are', () => {
  /*
   * Premium grants the metered features and Free grants none of them, which is
   * the split printed on What it costs rather than a second opinion about it.
   * The day BILLING.live goes on, this matrix is what closes - and one that
   * disagreed with the page would take somebody's money for something they
   * already had.
   */
  assert.deepEqual(TIERS.premium.grants.slice().sort(), Object.keys(FEATURES).sort());
  assert.deepEqual(TIERS.free.grants, []);
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
  assert.equal(planSummary(null, { billing: LIVE }).includes.length, 0);
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
  assert.equal(say(trial(9)), 'Premium trial, 9 days left.');
  assert.equal(say(trial(1)), 'Premium trial, 1 day left.', 'not "1 days"');
  // Rounded up, so the last afternoon of a trial does not read as zero.
  assert.equal(say(trial(0.25)), 'Premium trial, 1 day left.');
  assert.equal(say(trial(-1)), 'Premium trial, ending today.');
});

test('tiers: a grant with no end date does not pretend to have one', () => {
  assert.equal(
    describePlan({ tier: 'premium', source: 'granted', until: null }, { now: LIVE_NOW, billing: LIVE }),
    'Premium.',
  );
});

test('tiers: nothing is said about a trial while there is nothing to lose', () => {
  // Billing is off, so every account has everything and a countdown would be
  // counting down to nothing happening.
  assert.equal(
    describePlan({ tier: 'premium', source: 'trial', until: new Date(LIVE_NOW).toISOString() }, { billing: FREE }),
    'Free, with everything switched on.',
  );
});

test('tiers: a plan nobody has answered with yet is not premium', () => {
  // Null means the question has not been asked, which must not read as a grant.
  assert.equal(describePlan(null, { billing: LIVE }), 'Free.');
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
