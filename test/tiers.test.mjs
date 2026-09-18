import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURES, TIERS, DEFAULT_TIER, tierFor,
  can, gateReason, planSummary, describePlan,
  daysLeft, featureForLayer, describePrice, purchaseRoute,
  premiumAdds, annualSaving, plansOffered, offersUpgrade, isBillingTester,
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

/*
 * The other half of the test above: a trial stays quiet, a purchase does not.
 *
 * This is what a test-mode card is for. Paying with 4242 4242 4242 4242 in
 * Stripe's test mode writes a real entitlement row, and while billing is off
 * the panel above it used to go on saying Free - which looks exactly like the
 * webhook never arriving, and sends somebody to read function logs to tell a
 * working purchase from a broken one.
 */
test('tiers: a purchase is named even while billing is off', () => {
  const held = (source) => tierFor({ plan: { tier: 'premium', source } }, { billing: FREE }).name;
  assert.equal(held('stripe'), 'Premium');
  assert.equal(held('appstore'), 'Premium');
  assert.equal(held('granted'), 'Premium');

  // And the ones that mean "has not bought anything" still read as Free, which
  // while billing is off is what everybody is.
  assert.equal(held('trial'), 'Free');
  assert.equal(held('none'), 'Free');
  assert.equal(held(undefined), 'Free');

  // The end date comes with it, for the same reason: "30 days left" is how a
  // test purchase shows it wrote a real period end.
  assert.equal(
    describePlan(
      { tier: 'premium', source: 'stripe', until: new Date(LIVE_NOW + 30 * DAY).toISOString() },
      { now: LIVE_NOW, billing: FREE },
    ),
    '30 days left.',
  );
});

/*
 * Naming the tier must not gate anything, which is the whole risk of the test
 * above. Everything is open to everybody while billing is off, and a premium
 * name appearing in the panel has to leave that exactly as it was.
 */
test('tiers: naming a purchase does not take anything away from anybody', () => {
  const paid = planSummary({ plan: { tier: 'premium', source: 'stripe' } }, { billing: FREE });
  assert.equal(paid.name, 'Premium');
  assert.equal(paid.live, false);
  assert.equal(paid.includes.length, Object.keys(FEATURES).length);

  // Free is the tier whose grants are nearly empty, so it is the one that
  // would have lost something had this been read off the tier.
  const unpaid = planSummary({ plan: { tier: 'free', source: 'none' } }, { billing: FREE });
  assert.equal(unpaid.name, 'Free');
  assert.equal(unpaid.includes.length, Object.keys(FEATURES).length);
  assert.equal(can('rvRouting', { billing: FREE }), true);
});

/*
 * Three words, and a trial is one of them.
 *
 * The label used to read off the tier, which called a trial Premium - true,
 * because a trial grants everything, and useless as a label: the one state
 * with a clock on it read identically to the one without.
 */
test('tiers: the plan is named in one word, and the trial is named as one', () => {
  const named = (source, tier = 'premium', billing = FREE) =>
    planSummary({ plan: { tier, source } }, { billing }).name;

  assert.equal(named('none', 'free'), 'Free');
  assert.equal(named('trial'), 'Trial');
  assert.equal(named('stripe'), 'Premium');
  assert.equal(named('granted'), 'Premium');
  assert.equal(named('appstore'), 'Premium');

  // The same three words once billing is live: the label is about what
  // somebody is on, which does not change when the gates start meaning
  // something.
  assert.equal(named('none', 'free', LIVE), 'Free');
  assert.equal(named('trial', 'premium', LIVE), 'Trial');
  assert.equal(named('stripe', 'premium', LIVE), 'Premium');

  // And nothing else ever appears there.
  for (const source of ['none', 'trial', 'stripe', 'granted', 'appstore', 'nonsense']) {
    assert.ok(['Free', 'Trial', 'Premium'].includes(named(source)), `${source} produced another word`);
  }
});

test('tiers: naming the trial does not take the countdown off the upgrade panel', () => {
  /*
   * The gear shows the word and stops, but the map's upgrade block still opens
   * with "Trial, 21 days left. Keeping it:" - which is the one place the
   * number does any work, because the thing that stops the clock is under it.
   * So describePlan must keep answering even though the menu no longer asks.
   */
  const until = new Date(LIVE_NOW + 21 * DAY).toISOString();
  const summary = planSummary(
    { plan: { tier: 'premium', source: 'trial', until } },
    { billing: LIVE },
  );
  assert.equal(summary.name, 'Trial');
  assert.equal(describePlan({ tier: 'premium', source: 'trial', until }, { now: LIVE_NOW, billing: LIVE }),
    'Trial, 21 days left.');
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

  /*
   * Feature keys named in a gate anywhere in the app, aliases resolved the way
   * can() itself resolves them.
   *
   * `allowed` counts as well as `can`: the viewer asks its gates through a
   * helper that binds the reader's tier, and a scrape that only knew the bare
   * form reported every one of those features as ungated the moment that
   * landed - which is this test failing for the opposite of its reason.
   */
  const gated = new Set();
  for (const source of sources) {
    for (const [, named] of source.matchAll(/\b(?:can|allowed)\('([a-zA-Z]+)'\s*(?:,[^)]*)?\)/g)) {
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

/* ------------------------------------------------------------ the price */

test('tiers: the price is written the way a person writes it', () => {
  const billing = {
    defaultPlan: 'month',
    plans: { month: { price: 499, period: 'month' }, year: { price: 4900, period: 'year' } },
  };
  assert.equal(describePrice({ billing }), '$4.99 a month', 'the default plan when none is named');
  assert.equal(describePrice({ plan: 'month', billing }), '$4.99 a month');
  // Whole dollars lose the zeros: "$49 a year" is how somebody says it and
  // "$49.00 a year" is how a form does.
  assert.equal(describePrice({ plan: 'year', billing }), '$49 a year');
  // Nothing rather than "$0 a month", "$NaN a month" or a throw.
  assert.equal(describePrice({ plan: 'decade', billing }), '');
  assert.equal(describePrice({ billing: { plans: {} } }), '');
});

test('tiers: what the year saves is worked out, not asserted', () => {
  /*
   * "Two months free" is the sentence everybody reaches for and at these
   * prices it is a lie by a few dollars: $49 buys a shade under ten months,
   * not ten. Computing it means the page cannot overstate the discount, and
   * cannot go stale when a price moves.
   */
  const saving = annualSaving({
    billing: { plans: { month: { price: 499 }, year: { price: 4900 } } },
  });
  assert.equal(saving.money, '$10.88');
  assert.equal(saving.percent, 18);

  // Nothing to say when the year is not cheaper, rather than "saves $0".
  assert.equal(annualSaving({ billing: { plans: { month: { price: 499 }, year: { price: 5988 } } } }), null);
  assert.equal(annualSaving({ billing: { plans: { month: { price: 499 } } } }), null);
});

test('tiers: how somebody would buy it, and the answers that differ', () => {
  /*
   * Four states, not a boolean, because the panel draws each differently and
   * conflating any two of them shows somebody the wrong thing.
   *
   * The one worth keeping straight: a browser cannot complete an App Store
   * purchase. Reporting that as "buyable" would put a button on a page where
   * pressing it can only fail, so it is reported as a place to go instead.
   */
  assert.deepEqual(purchaseRoute({ billing: { live: false, store: 'stripe' } }),
    { available: false, why: 'not-live' }, 'nothing is for sale before billing is live');
  assert.deepEqual(purchaseRoute({ billing: { live: true, store: 'none' } }),
    { available: false, why: 'no-store' }, 'live with nowhere to buy');
  assert.deepEqual(purchaseRoute({ billing: { live: true, store: 'appstore' } }),
    { available: false, why: 'in-app-only' }, 'the App Store cannot be reached from a browser');
  assert.deepEqual(purchaseRoute({ billing: { live: true, store: 'stripe' } }),
    { available: true, where: 'stripe' }, 'Stripe is the one a browser can finish');
});

test('tiers: nothing is for sale today', () => {
  // The shipped state, asserted rather than assumed. A commit that turned
  // billing on as a side effect of something else has to trip over this.
  assert.equal(purchaseRoute().available, false);
});

test('tiers: both plans are on offer', () => {
  const ids = plansOffered().map((plan) => plan.id);
  assert.deepEqual(ids, ['month', 'year']);
});

test('tiers: what Premium adds is the difference, not a third copy of the list', () => {
  const adds = premiumAdds();
  // Place search is free now, so it is not something Premium adds.
  assert.equal(adds.includes(FEATURES.placeSearch), false);
  assert.equal(adds.includes(FEATURES.folderSync), true);
  assert.equal(adds.length, Object.keys(FEATURES).length - TIERS.free.grants.length);
});

test('tiers: the price on the website is the price in the code', async () => {
  /*
   * The page is static HTML and cannot read BILLING, so the number is typed
   * in twice. Two copies of a price disagree eventually, and the one people
   * read is not always the one they are charged. Same reason the tier split
   * is read off the page rather than restated: a decision kept in two files
   * needs something that notices when they part company.
   */
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const plan of plansOffered()) {
    const said = describePrice({ plan: plan.id });
    assert.equal(page.includes(said), true, `the costs page does not say ${said}`);
  }
});

test('tiers: a trial is offered the thing that stops it ending', () => {
  /*
   * The bug this exists for, which was invisible: a trial reads as premium
   * everywhere, correctly, because everything works. Reading it that way in
   * the panel meant nobody could subscribe during their first thirty days -
   * they would have had to let the trial lapse, lose it all, and only then be
   * shown the thing that would have kept it. The person it happened to would
   * simply not have seen a button.
   */
  const summary = (source, tier = 'premium') => ({
    live: true, source, tier: { id: tier },
  });

  assert.equal(offersUpgrade(summary('trial')), true, 'a trial is not paying yet');
  assert.equal(offersUpgrade(summary('none', 'free')), true, 'and neither is free');

  // Somebody who is actually paying is not sold it again.
  assert.equal(offersUpgrade(summary('stripe')), false);
  assert.equal(offersUpgrade(summary('appstore')), false);
  // Nor is somebody who was given it.
  assert.equal(offersUpgrade(summary('granted')), false);

  // And nothing at all is offered while billing is off, whatever the source.
  assert.equal(offersUpgrade({ live: false, source: 'trial', tier: { id: 'premium' } }), false);
  assert.equal(offersUpgrade(null), false);
});

test('tiers: the test-mode panel does not try to sell to somebody who already pays', () => {
  /*
   * Reported from a phone: signed in on an account holding a permanent granted
   * entitlement, the panel drew "$4.99 a month" and "$49 a year".
   *
   * The test above missed it by building its summaries by hand with
   * `tier: { id: 'premium' }` - a shape planSummary never produces while
   * billing is off, because tierFor flattens everybody to Free then. The
   * preview forces `live: true` onto exactly such a summary, so the old check
   * on tier.id saw Free for everybody and offered to sell Premium to an
   * account that already had it. The server refused with a 409, which is the
   * safety net working and not an interface anybody should meet.
   *
   * So this one goes through the real planSummary, with billing off, the way
   * the panel does.
   */
  const asPanel = (source) => {
    const account = source === 'none' ? null : { plan: { tier: 'premium', source, until: null } };
    // Exactly what upgradeBlock does: summarise with billing off, then force
    // live on for the preview.
    return offersUpgrade({ ...planSummary(account, { billing: FREE }), live: true });
  };

  assert.equal(asPanel('granted'), false, 'a granted account is not sold what it was given');
  assert.equal(asPanel('stripe'), false, 'and an account already paying by card is not sold it twice');
  assert.equal(asPanel('appstore'), false);
  // The two that should still see the buttons, because neither is paying.
  assert.equal(asPanel('trial'), true);
  assert.equal(asPanel('none'), true);
});

test('tiers: an entitlement source nobody taught this about still gets a button', () => {
  /*
   * Which way an unknown source should fail, decided rather than left to
   * whichever branch happened to come first. Offering a purchase to somebody
   * who turns out to be paying already ends at a refusal they can read;
   * withholding it from somebody who is not ends in a free account that is
   * never shown a way to pay and never says why.
   */
  assert.equal(offersUpgrade({ live: true, source: 'play' }), true);
  assert.equal(offersUpgrade({ live: true }), true);
});

test('tiers: a preview offers the web checkout before billing is live', () => {
  /*
   * How the people who run this reach a checkout to test one, without a
   * Subscribe button appearing for everybody else.
   *
   * It decides what is drawn and nothing else. The checkout function refuses
   * anybody not named as a tester while the Stripe key is a test key, because
   * a hidden button is not a control: that function is reachable by anybody
   * holding a session whether or not the app ever draws one.
   */
  const off = { live: false, store: 'none' };
  assert.deepEqual(purchaseRoute({ billing: off }), { available: false, why: 'not-live' });
  assert.deepEqual(purchaseRoute({ billing: off, preview: true }),
    { available: true, where: 'stripe', preview: true });

  // Once billing is live the preview flag changes nothing: the configured
  // store decides, and a preview must not quietly override it.
  assert.deepEqual(purchaseRoute({ billing: { live: true, store: 'appstore' }, preview: true }),
    { available: false, why: 'in-app-only' });
  assert.deepEqual(purchaseRoute({ billing: { live: true, store: 'stripe' }, preview: true }),
    { available: true, where: 'stripe' });
});

test('tiers: who is shown the test-mode purchase panel', () => {
  /*
   * A list of addresses that decides which button is drawn, and nothing else.
   *
   * The matching thing that decides who may actually pay is BILLING_TESTERS on
   * the Edge Functions, and it has to be the one that counts: this list is
   * shipped to the reader's computer, where they can edit it, so treating it
   * as permission would mean anybody could hand themselves a test-mode
   * checkout - which is a real entitlement bought with a card that is not a
   * card. These tests are about a button appearing.
   */
  const billing = { testers: ['first@example.com', 'second@example.com'] };
  assert.equal(isBillingTester({ email: 'first@example.com' }, { billing }), true);
  assert.equal(isBillingTester({ email: 'second@example.com' }, { billing }), true);
  assert.equal(isBillingTester({ email: 'somebody@example.com' }, { billing }), false);

  // Addresses arrive from a sign-in form and from a pasted secret, so neither
  // case nor stray whitespace decides whether the panel appears.
  assert.equal(isBillingTester({ email: '  First@Example.com ' }, { billing }), true);

  // No account, no email, no panel - and an empty list means nobody rather
  // than everybody, which is the difference between a quiet default and a
  // free subscription for whoever signs in.
  assert.equal(isBillingTester(null, { billing }), false);
  assert.equal(isBillingTester({}, { billing }), false);
  assert.equal(isBillingTester({ email: '' }, { billing }), false);
  assert.equal(isBillingTester({ email: 'first@example.com' }, { billing: { testers: [] } }), false);
  assert.equal(isBillingTester({ email: 'first@example.com' }, { billing: {} }), false);
});

test('tiers: nobody is a tester in the shipped configuration', () => {
  // The committed default, asserted: the list is injected at build time and
  // the repository is public, so an address appearing in it here would be
  // somebody's real address in a public file.
  assert.equal(isBillingTester({ email: 'anybody@example.com' }), false);
});

/* ------------------------------------------- the tier has to reach the gate */

test('tiers: with billing live, a gate asked without a tier answers Free', () => {
  /*
   * The trap, written down because it is invisible until the day it is not.
   *
   * `can()` falls back to Free when nobody passes a tier, and while billing is
   * off it never gets that far - it answers true for everything first. So an
   * app that never passed a tier looks completely correct, right up to the
   * moment the flag is turned on, and then every gate closes on the people who
   * just paid. "Subscribing took my basemaps away" is the report that follows.
   */
  const premium = { plan: { tier: 'premium', source: 'stripe' } };

  assert.equal(can('extraBasemaps', { billing: LIVE }), false,
    'no tier means Free, and Free does not include the metered basemaps');
  assert.equal(can('extraBasemaps', { billing: LIVE, tier: tierFor(premium, { billing: LIVE }) }), true,
    'the account that pays for them has to get them');

  // And the same question with billing off is true either way, which is what
  // makes the omission undetectable until the flag flips.
  assert.equal(can('extraBasemaps', { billing: FREE }), true);
});

test('tiers: every gate in the app is asked against the reader’s plan', async () => {
  /*
   * Asserted on the source because there is nowhere else it lives: the bug is
   * a missing argument, it is silent, and the only browser that could show it
   * is one with billing switched on.
   *
   * viewer.js goes through `allowed`/`lockedBecause`, which bind the tier from
   * the account; account.js passes `tierFor(this)`. A bare `can('...')` or
   * `gateReason('...')` in either is the omission coming back.
   */
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));

  const bare = [];
  for (const file of ['../assets/js/viewer.js', '../assets/js/lib/account.js']) {
    const source = readFileSync(path.join(here, file), 'utf8');
    source.split('\n').forEach((line, index) => {
      // Comments explain the rule and quote the broken form; they are prose.
      const code = line.replace(/^\s*(\*|\/\/).*$/, '');
      for (const match of code.matchAll(/(?:^|[^.\w])(can|gateReason)\(\s*'([^']+)'([^)]*)\)/g)) {
        if (!match[3].includes('tier')) bare.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(bare, [], `a gate is resolving against the default tier:\n${bare.join('\n')}`);
});
