/**
 * How long a trip actually takes, given what is in the queue.
 *
 * The problem this exists for, in the words it was reported in: "I put too much
 * in my queue and forget how far everything is between each other. And then I
 * don't add time in to eat, refuel, and sleep."
 *
 * So this is not a router and does not pretend to be one. It has no road
 * network, gives no turns, and is wrong about any individual leg. What it is
 * right about is the shape of the thing: eleven stops across four counties is
 * three days, not a weekend, and you will stop to eat twice a day whether or
 * not you planned to. That answer needs no network, which matters — trips get
 * planned at a kitchen table and re-planned at a trailhead with no signal.
 *
 * Every number below is an assumption with a default you can change, and each
 * one is stated rather than buried, because a plan you cannot argue with is a
 * plan you cannot trust.
 */

import { haversine } from './geo.js';

const MILES_PER_METRE = 0.000621371;

/**
 * The defaults, and why each is what it is.
 *
 * `winding` is the one people query. A straight line between two points on a
 * ridge road is not the drive; the road goes round the ridge. 1.35 is the
 * ratio that holds up over Appalachian and Ozark backroads — it is nearer 1.15
 * on a plains grid and can pass 1.8 in canyon country, which is why it is a
 * setting and not a constant.
 */
export const TRIP_DEFAULTS = {
  // Not motorway speed. This is the average including the gravel, the gates,
  // and the pulling over — door to door, not the number on the dashboard.
  speedMph: 32,
  winding: 1.35,
  // Six hours is a long day of backroad driving. Eight is a day you finish
  // too tired to shoot anything, which for this app is the point of the trip.
  drivingHoursPerDay: 6,
  // Per stop, on the ground. A viewpoint is ten minutes and a hike is three
  // hours; this is the average that makes the day-count roughly honest.
  stopMinutes: 45,
  mealMinutes: 45,
  mealsPerDay: 2,
  fuelMinutes: 20,
  // A tank on backroads, with a margin. The point is that a long day has a
  // fuel stop in it whether or not you remembered to plan one.
  fuelMiles: 220,
};

/** Road miles between two points: great-circle, then bent to fit a road. */
export function legMiles(from, to, winding = TRIP_DEFAULTS.winding) {
  return haversine(from, to) * MILES_PER_METRE * winding;
}

/**
 * The legs between an ordered list of stops.
 *
 * @param {{position: number[], name?: string}[]} stops
 * @returns {{from: number, to: number, miles: number, minutes: number}[]}
 */
export function tripLegs(stops, options = {}) {
  const { winding, speedMph } = { ...TRIP_DEFAULTS, ...options };
  const legs = [];

  for (let index = 0; index + 1 < stops.length; index += 1) {
    const miles = legMiles(stops[index].position, stops[index + 1].position, winding);
    legs.push({
      from: index,
      to: index + 1,
      miles,
      minutes: speedMph > 0 ? (miles / speedMph) * 60 : 0,
    });
  }
  return legs;
}

/**
 * Split the queue into days you could actually drive.
 *
 * Greedy and in queue order, deliberately: the order is the plan the person
 * made, and a planner that quietly reorders it to fit is answering a question
 * nobody asked. `optimiseOrder` is a separate, explicit press.
 *
 * A leg longer than a whole day's driving gets a day of its own and is marked,
 * rather than being split at an arbitrary point where there may be nowhere to
 * stop.
 *
 * @returns {{days: Array, totals: Object, verdict: Object}}
 */
export function planTrip(stops, options = {}) {
  const settings = { ...TRIP_DEFAULTS, ...options };
  const legs = tripLegs(stops, settings);
  const budget = Math.max(30, settings.drivingHoursPerDay * 60);

  const days = [];
  let day = null;

  const startDay = (firstStop) => {
    day = {
      index: days.length + 1,
      from: firstStop,
      to: firstStop,
      stops: [firstStop],
      miles: 0,
      driveMinutes: 0,
      long: false,
    };
    days.push(day);
  };

  if (stops.length) startDay(0);

  for (const leg of legs) {
    const wouldBe = day.driveMinutes + leg.minutes;
    // A leg that cannot fit in an empty day is not a planning failure, it is a
    // long drive. It gets its own day and says so.
    const alone = leg.minutes > budget;

    if (day.driveMinutes > 0 && wouldBe > budget) startDay(leg.from);

    day.driveMinutes += leg.minutes;
    day.miles += leg.miles;
    day.stops.push(leg.to);
    day.to = leg.to;
    if (alone) day.long = true;
  }

  for (const entry of days) {
    // Stops, not places: the first stop of a day you drove to yesterday is
    // where you woke up, so it does not cost another stop's worth of time.
    const visited = entry.index === 1 ? entry.stops.length : entry.stops.length - 1;
    entry.stopMinutes = visited * settings.stopMinutes;
    entry.mealMinutes = settings.mealsPerDay * settings.mealMinutes;
    entry.fuelMinutes = Math.floor(entry.miles / settings.fuelMiles) * settings.fuelMinutes;
    entry.totalMinutes = entry.driveMinutes + entry.stopMinutes + entry.mealMinutes + entry.fuelMinutes;
  }

  const totals = {
    stops: stops.length,
    miles: legs.reduce((sum, leg) => sum + leg.miles, 0),
    driveMinutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
    days: days.length,
    totalMinutes: days.reduce((sum, entry) => sum + entry.totalMinutes, 0),
  };

  return { legs, days, totals, verdict: verdictFor(days.length, settings.days), settings };
}

/**
 * Whether the plan fits the dates, said as a sentence.
 *
 * The whole point of the feature: a queue that needs five days and a weekend
 * booked to do it in is the mistake, and it is invisible until somebody counts.
 */
function verdictFor(needed, available) {
  if (!Number.isFinite(available) || available <= 0) {
    return { state: 'open', needed, text: `About ${needed} day${needed === 1 ? '' : 's'} of driving.` };
  }
  if (needed <= available) {
    const spare = available - needed;
    return {
      state: 'fits',
      needed,
      text: spare
        ? `Fits, with ${spare} day${spare === 1 ? '' : 's'} spare.`
        : 'Fits, with nothing spare.',
    };
  }
  return {
    state: 'over',
    needed,
    text: `Needs about ${needed} days and you have ${available}. Drop some stops, or add days.`,
  };
}

/**
 * Reorder the queue into a shorter drive, without moving the start.
 *
 * Nearest-neighbour for a first pass, then 2-opt until it stops improving —
 * which for the ten or twenty stops a trip actually holds finds an order
 * within a few per cent of the best one, in a millisecond, with no network.
 *
 * The first stop is fixed because it is where you are leaving from. The last
 * is only fixed on request: a loop back to the start is a different trip from
 * a run out to somewhere and this cannot tell which you meant.
 *
 * @returns {{order: number[], milesBefore: number, milesAfter: number}}
 */
export function optimiseOrder(stops, { winding = TRIP_DEFAULTS.winding, fixLast = false } = {}) {
  const count = stops.length;
  const before = totalMiles(stops.map((_, index) => index), stops, winding);
  if (count < 4) return { order: stops.map((_, index) => index), milesBefore: before, milesAfter: before };

  const distance = (a, b) => legMiles(stops[a].position, stops[b].position, winding);

  // Nearest neighbour from the start.
  const remaining = new Set(stops.map((_, index) => index));
  remaining.delete(0);
  const end = fixLast ? count - 1 : null;
  if (end !== null) remaining.delete(end);

  const order = [0];
  while (remaining.size) {
    const last = order[order.length - 1];
    let best = null;
    for (const candidate of remaining) {
      const span = distance(last, candidate);
      if (!best || span < best.span) best = { candidate, span };
    }
    order.push(best.candidate);
    remaining.delete(best.candidate);
  }
  if (end !== null) order.push(end);

  /*
   * 2-opt: reverse any span that crosses itself.
   *
   * Nearest neighbour paints itself into corners — it will happily strand one
   * stop on the far side of the county and drive back for it at the end. This
   * unpicks exactly that, and the first and last positions are held fixed
   * because they are the ones the caller decided.
   */
  const lastMovable = end === null ? order.length - 1 : order.length - 2;
  let improved = true;
  let passes = 0;
  while (improved && passes < 40) {
    improved = false;
    passes += 1;
    for (let i = 1; i < lastMovable; i += 1) {
      for (let k = i + 1; k <= lastMovable; k += 1) {
        const a = order[i - 1];
        const b = order[i];
        const c = order[k];
        const d = k + 1 < order.length ? order[k + 1] : null;

        const now = distance(a, b) + (d === null ? 0 : distance(c, d));
        const swapped = distance(a, c) + (d === null ? 0 : distance(b, d));
        if (swapped + 1e-9 < now) {
          order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }

  return { order, milesBefore: before, milesAfter: totalMiles(order, stops, winding) };
}

function totalMiles(order, stops, winding) {
  let miles = 0;
  for (let index = 0; index + 1 < order.length; index += 1) {
    miles += legMiles(stops[order[index]].position, stops[order[index + 1]].position, winding);
  }
  return miles;
}

/** "4 h 20" — hours and minutes, never a bare count of minutes. */
export function spellHours(minutes) {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
}
