import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURES, TIERS, DEFAULT_TIER, tierFor, can, gateReason, planSummary,
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

test('tiers: and the free plan really does list them all', () => {
  assert.deepEqual(TIERS.free.grants.slice().sort(), Object.keys(FEATURES).sort());
});

/*
 * The flag has to actually be load-bearing. A `can()` that returned true
 * whatever the flag said would pass the test above and be scaffolding that
 * holds nothing up — so the closed world is exercised too, against a tier that
 * grants one feature.
 */
test('tiers: with billing live, the matrix is what decides', () => {
  const limited = { id: 'trial', name: 'Trial', grants: ['fogForecast'], note: '' };
  assert.equal(can('fogForecast', { tier: limited, billing: LIVE }), true);
  assert.equal(can('roadRoute', { tier: limited, billing: LIVE }), false);
  // And the same call with billing off is open again, so the flag is the switch.
  assert.equal(can('roadRoute', { tier: limited, billing: FREE }), true);
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
  assert.match(said, /height, width and weight/);
  assert.match(said, /Free/);
  assert.match(gateReason('nonsense'), /not something this app does/);
});

test('tiers: the plan summary says both what you have and whether it is real yet', () => {
  const summary = planSummary(null, { billing: FREE });
  assert.equal(summary.name, 'Free');
  assert.equal(summary.live, false);
  assert.equal(summary.includes.length, Object.keys(FEATURES).length);
  assert.match(summary.note, /free while Halfstop is being built/);
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
