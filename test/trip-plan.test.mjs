/**
 * The trip planner.
 *
 * It answers one question — "is what I have queued up actually a weekend?" —
 * and it answers it with no network, because trips get re-planned at a
 * trailhead with no signal. These check the arithmetic and, more importantly,
 * the judgement calls: what counts as a day, what a stop costs, and when the
 * answer is "you have queued too much".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIP_DEFAULTS, legMiles, tripLegs, planTrip, optimiseOrder, spellHours,
} from '../assets/js/lib/trip-plan.js';

/* Real places, so the distances can be checked against a map. */
const KNOXVILLE = [-83.92, 35.96];
const GATLINBURG = [-83.51, 35.71];
const ASHEVILLE = [-82.55, 35.60];
const NASHVILLE = [-86.78, 36.16];
const CHATTANOOGA = [-85.31, 35.05];

const at = (position, name) => ({ position, name });

test('plan: a leg is the straight line bent to fit a road', () => {
  /*
   * Knoxville to Gatlinburg is about 27 miles as the crow flies and about 40
   * by road. The winding factor is the whole of the difference, and getting it
   * wrong is the difference between a plan and a fantasy.
   */
  const straight = legMiles(KNOXVILLE, GATLINBURG, 1);
  assert.ok(Math.abs(straight - 27) < 2, `straight line was ${straight.toFixed(1)} mi`);

  const road = legMiles(KNOXVILLE, GATLINBURG);
  assert.ok(road > straight, 'the road is longer than the line');
  assert.ok(Math.abs(road - 37) < 3, `road estimate was ${road.toFixed(1)} mi`);
});

test('plan: legs run between consecutive stops, in queue order', () => {
  const legs = tripLegs([at(KNOXVILLE), at(GATLINBURG), at(ASHEVILLE)]);
  assert.equal(legs.length, 2, 'three stops make two legs');
  assert.deepEqual(legs.map((leg) => [leg.from, leg.to]), [[0, 1], [1, 2]]);
  for (const leg of legs) {
    assert.ok(leg.miles > 0 && leg.minutes > 0);
    // At the default speed, an hour is about thirty-two miles.
    assert.ok(Math.abs(leg.minutes - (leg.miles / TRIP_DEFAULTS.speedMph) * 60) < 1e-6);
  }
  assert.deepEqual(tripLegs([at(KNOXVILLE)]), [], 'one stop is not a drive');
  assert.deepEqual(tripLegs([]), []);
});

test('plan: a short queue is one day, and says so', () => {
  const plan = planTrip([at(KNOXVILLE, 'Home'), at(GATLINBURG, 'Elkmont')]);
  assert.equal(plan.days.length, 1);
  assert.equal(plan.totals.stops, 2);
  assert.deepEqual(plan.days[0].stops, [0, 1]);
  assert.ok(plan.days[0].driveMinutes < 90, 'forty miles is not a day of driving');
});

test('plan: the queue is split where the driving day runs out', () => {
  /*
   * The reported problem, exactly: a queue that looks like a weekend and is
   * not. Nashville to Asheville and back across the state is well past one
   * day of backroad driving, and nothing in a list of pins says so.
   */
  const plan = planTrip([
    at(NASHVILLE, 'Nashville'),
    at(CHATTANOOGA, 'Chattanooga'),
    at(KNOXVILLE, 'Knoxville'),
    at(ASHEVILLE, 'Asheville'),
  ], { drivingHoursPerDay: 4 });

  assert.ok(plan.days.length >= 2, `four hours a day cannot do this in one; got ${plan.days.length}`);
  for (const day of plan.days) {
    // Each day is inside its budget, unless a single leg is longer than a
    // whole day — which is a long drive, not a planning failure.
    assert.ok(day.driveMinutes <= 4 * 60 + 1e-6 || day.long,
      `day ${day.index} drives ${day.driveMinutes} minutes`);
  }

  // Every stop lands in exactly one day, and the days join up.
  const visited = plan.days.flatMap((day) => day.stops);
  assert.deepEqual([...new Set(visited)].sort((a, b) => a - b), [0, 1, 2, 3]);
  for (let index = 1; index < plan.days.length; index += 1) {
    assert.equal(plan.days[index].stops[0], plan.days[index - 1].to,
      'a day starts where the last one ended');
  }
});

test('plan: a leg longer than a whole day gets its own day and is marked', () => {
  // Splitting it at an arbitrary point would put the overnight somewhere there
  // may be nothing at all. Saying "this one leg is a whole day" is the honest
  // answer.
  const plan = planTrip([at(NASHVILLE), at(ASHEVILLE)], { drivingHoursPerDay: 1 });
  assert.equal(plan.days.length, 1);
  assert.equal(plan.days[0].long, true);
});

test('plan: the day counts eating, refuelling and being out of the car', () => {
  /*
   * "I don't add time in to eat, refuel, and sleep." A day is not its driving
   * hours, and a plan that reports only those is the plan that goes wrong.
   */
  const plan = planTrip([at(NASHVILLE), at(CHATTANOOGA), at(KNOXVILLE)]);
  const day = plan.days[0];

  assert.ok(day.driveMinutes > 0);
  assert.equal(day.mealMinutes, TRIP_DEFAULTS.mealsPerDay * TRIP_DEFAULTS.mealMinutes);
  assert.ok(day.stopMinutes > 0, 'stops take time on the ground');
  assert.equal(day.totalMinutes,
    day.driveMinutes + day.stopMinutes + day.mealMinutes + day.fuelMinutes);
  assert.ok(day.totalMinutes > day.driveMinutes + 60,
    'the day is meaningfully longer than the driving');
});

test('plan: the first stop of a later day is where you woke up', () => {
  // It was visited yesterday. Charging another stop's worth of time for it
  // would add an hour a day that nobody spends.
  const stops = [at(NASHVILLE), at(CHATTANOOGA), at(KNOXVILLE), at(ASHEVILLE)];
  const plan = planTrip(stops, { drivingHoursPerDay: 3, stopMinutes: 60 });
  assert.ok(plan.days.length > 1, 'this test needs more than one day');

  for (const day of plan.days) {
    const charged = day.index === 1 ? day.stops.length : day.stops.length - 1;
    assert.equal(day.stopMinutes, charged * 60);
  }
});

test('plan: a long day picks up a fuel stop, a short one does not', () => {
  const short = planTrip([at(KNOXVILLE), at(GATLINBURG)]);
  assert.equal(short.days[0].fuelMinutes, 0, 'forty miles is not a tank');

  const long = planTrip([at(NASHVILLE), at(ASHEVILLE)], { drivingHoursPerDay: 24 });
  assert.ok(long.days[0].miles > TRIP_DEFAULTS.fuelMiles);
  assert.equal(long.days[0].fuelMinutes, TRIP_DEFAULTS.fuelMinutes);
});

test('plan: the verdict compares the plan against the dates you booked', () => {
  const stops = [at(NASHVILLE), at(CHATTANOOGA), at(KNOXVILLE), at(ASHEVILLE)];

  const over = planTrip(stops, { drivingHoursPerDay: 2, days: 1 });
  assert.equal(over.verdict.state, 'over');
  assert.match(over.verdict.text, /Needs about \d+ days and you have 1/);

  // Four hundred miles of backroads is two days at ten driving hours each,
  // which is the sort of thing this exists to say out loud.
  const fits = planTrip(stops, { drivingHoursPerDay: 10, days: 3 });
  assert.equal(fits.verdict.state, 'fits');
  assert.match(fits.verdict.text, /1 day spare/);

  const exact = planTrip(stops, { drivingHoursPerDay: 10, days: 2 });
  assert.equal(exact.verdict.state, 'fits');
  assert.match(exact.verdict.text, /nothing spare/);

  // No dates on the folder: report the length rather than judging it.
  const open = planTrip(stops, { drivingHoursPerDay: 10 });
  assert.equal(open.verdict.state, 'open');
  assert.match(open.verdict.text, /About 2 days/);
});

test('plan: an empty queue plans nothing rather than throwing', () => {
  // The trip folder is empty the moment it is created, and the panel renders
  // it before anything is in it.
  const plan = planTrip([]);
  assert.deepEqual(plan.days, []);
  assert.equal(plan.totals.stops, 0);
  assert.equal(plan.totals.miles, 0);
  assert.equal(plan.verdict.state, 'open');
});

/* ------------------------------------------------------------- optimising */

test('optimise: an order that doubles back is unpicked', () => {
  /*
   * Queued in the order they were thought of, which is how a queue is really
   * built: Nashville, then the far end at Asheville, then the two in between.
   * Driving it in that order crosses the state three times.
   */
  const stops = [at(NASHVILLE, 'start'), at(ASHEVILLE, 'far'), at(CHATTANOOGA, 'mid'), at(KNOXVILLE, 'near')];
  const result = optimiseOrder(stops);

  assert.equal(result.order[0], 0, 'the start does not move — it is where you are');
  assert.ok(result.milesAfter < result.milesBefore, 'the point is a shorter drive');
  assert.deepEqual([...result.order].sort((a, b) => a - b), [0, 1, 2, 3], 'every stop survives');
  // West to east is the sensible run: Chattanooga, Knoxville, Asheville.
  assert.deepEqual(result.order, [0, 2, 3, 1]);
});

test('optimise: a round trip can be pinned at both ends', () => {
  const stops = [at(NASHVILLE, 'home'), at(ASHEVILLE), at(CHATTANOOGA), at(KNOXVILLE), at(NASHVILLE, 'home again')];
  const result = optimiseOrder(stops, { fixLast: true });

  assert.equal(result.order[0], 0);
  assert.equal(result.order[result.order.length - 1], 4, 'you end up back at the house');
  assert.deepEqual([...result.order].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test('optimise: too few stops to reorder is left exactly alone', () => {
  for (const count of [0, 1, 2, 3]) {
    const stops = [KNOXVILLE, GATLINBURG, ASHEVILLE, NASHVILLE].slice(0, count).map((p) => at(p));
    const result = optimiseOrder(stops);
    assert.deepEqual(result.order, stops.map((_, index) => index));
    assert.equal(result.milesBefore, result.milesAfter);
  }
});

test('optimise: never invents, drops or duplicates a stop', () => {
  /*
   * The failure that would matter most: a reorder that quietly loses the one
   * waypoint the whole trip was for. Checked over a spread of sizes because
   * the two-opt bounds are where an off-by-one would hide.
   */
  const spread = Array.from({ length: 14 }, (unused, index) => at([
    -86 + ((index * 7) % 11) * 0.4,
    35 + ((index * 5) % 9) * 0.3,
  ], `stop ${index}`));

  for (const count of [4, 5, 8, 14]) {
    const stops = spread.slice(0, count);
    for (const fixLast of [false, true]) {
      const { order } = optimiseOrder(stops, { fixLast });
      assert.equal(order.length, count, `${count} stops, fixLast=${fixLast}`);
      assert.deepEqual([...order].sort((a, b) => a - b), stops.map((_, index) => index));
    }
  }
});

test('optimise: the result is never longer than what it replaced', () => {
  // A reorder that made the drive worse would be the one thing this button
  // must never do, and greedy nearest-neighbour on its own sometimes does.
  const spread = Array.from({ length: 11 }, (unused, index) => at([
    -85 + Math.cos(index * 1.7) * 1.5,
    35.5 + Math.sin(index * 2.3) * 1.2,
  ]));
  const result = optimiseOrder(spread);
  assert.ok(result.milesAfter <= result.milesBefore + 1e-9,
    `${result.milesAfter.toFixed(1)} vs ${result.milesBefore.toFixed(1)}`);
});

test('plan: hours are spelled the way a person says them', () => {
  assert.equal(spellHours(0), '0 min');
  assert.equal(spellHours(45), '45 min');
  assert.equal(spellHours(60), '1 h');
  assert.equal(spellHours(260), '4 h 20');
  // Never "260 minutes", and never "4.33 hours".
  assert.equal(spellHours(59.6), '1 h');
});
