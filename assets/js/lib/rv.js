/**
 * Routing for something taller than a car, and the honest limits of doing it.
 *
 * Valhalla has a truck costing that takes a height, width, length and weight
 * and avoids ways whose tagged limits your vehicle exceeds. That sentence
 * contains the whole problem: *tagged*. The router is reading OpenStreetMap,
 * and in the United States the overwhelming majority of low bridges, narrow
 * tunnels and posted weight limits carry no `maxheight` or `maxweight` tag at
 * all. A route that comes back clean has not been checked against a limit that
 * was never written down.
 *
 * So everything this module produces is called an advisory, is worded as one,
 * and carries the caveat with it rather than in a help page. That is not
 * defensive boilerplate: the failure mode of quiet confidence here is a
 * motorhome roof against a stone bridge, and the app cannot see the bridge.
 *
 * WHAT IT DOES DO
 *
 * A tagged limit, where one exists, is real and worth routing around — it came
 * from somebody who stood under the bridge. Truck costing also prefers
 * designated truck routes and penalises the kind of lane a long wheelbase
 * cannot turn out of, which is useful independent of any tag. And a route
 * request that fails under your dimensions but succeeds without them is a
 * genuine, specific finding: something on the direct way is posted against you.
 *
 * UNITS
 *
 * Valhalla wants metres and metric tons regardless of what the directions are
 * asked for, so metres are what a profile stores. What a reader types is feet
 * and inches, because that is what is on the sticker inside an American RV's
 * door and re-typing it in metres is where the mistake gets made.
 */

const METRES_PER_FOOT = 0.3048;
const METRES_PER_INCH = 0.0254;
const TONNES_PER_SHORT_TON = 0.90718474;

/**
 * A vehicle nobody has described yet.
 *
 * `kind: 'car'` rather than an absent profile, so "I drive a car" is a thing
 * the reader has said rather than a thing the app assumed. Everything else is
 * roughly a 30-foot class C — a starting point to correct, not a guess to rely
 * on, and the panel says which of the two it is.
 */
export const RV_DEFAULTS = {
  kind: 'car',
  heightM: 3.4,
  widthM: 2.5,
  lengthM: 9.1,
  weightT: 5.9,
};

/*
 * What the fields will accept, in metres and tonnes.
 *
 * Wide enough for a bus and a fifth wheel, narrow enough that a typo of a
 * decimal place is rejected rather than routed on. A vehicle 34 metres tall is
 * not a vehicle, and sending it to the router would produce a confident refusal
 * that reads like a road problem.
 */
export const RV_RANGES = {
  heightM: [1.5, 6],
  widthM: [1.5, 4],
  lengthM: [2, 25],
  weightT: [0.5, 40],
};

/**
 * Feet and inches, however they were typed.
 *
 * `12'6"`, `12' 6`, `12 ft 6 in`, `12.5`, `12-6` — all of them are how somebody
 * writes down what is on the door sticker, and refusing four of the five is a
 * field people give up on. A bare number is feet, because "12" on a clearance
 * sign is feet.
 *
 * @returns {number|null} metres, or null if there is no number in there at all
 */
export function parseFeetInches(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  const match = /^(-?\d+(?:\.\d+)?)\s*(?:'|’|ft|feet|f)?\s*(?:[-\s]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|”|in|inch|inches)?)?\s*$/i
    .exec(text);
  if (!match) return null;

  const feet = Number(match[1]);
  if (!Number.isFinite(feet)) return null;
  const inches = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isFinite(inches) || inches < 0 || inches >= 12) {
    // 12'14" is a typo, not a measurement. Reading it as 13'2" would be a guess
    // about which digit was wrong.
    return match[2] === undefined ? feet * METRES_PER_FOOT : null;
  }
  return (feet * METRES_PER_FOOT) + (inches * METRES_PER_INCH);
}

/** Metres back to the feet-and-inches somebody would say out loud. */
export function formatFeetInches(metres) {
  if (!Number.isFinite(metres)) return '';
  const totalInches = Math.round(metres / METRES_PER_INCH);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return inches ? `${feet}' ${inches}"` : `${feet}'`;
}

export const shortTonsToTonnes = (tons) => tons * TONNES_PER_SHORT_TON;
export const tonnesToShortTons = (tonnes) => tonnes / TONNES_PER_SHORT_TON;

/** A dimension the reader typed, in the units they typed it in. */
export function readDimension(input, { metric = false } = {}) {
  if (metric) {
    const value = Number(String(input ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(value) ? value : null;
  }
  return parseFeetInches(input);
}

export function showDimension(metres, { metric = false } = {}) {
  if (!Number.isFinite(metres)) return '';
  return metric ? `${metres.toFixed(2)} m` : formatFeetInches(metres);
}

export function showWeight(tonnes, { metric = false } = {}) {
  if (!Number.isFinite(tonnes)) return '';
  return metric ? `${tonnes.toFixed(1)} t` : `${tonnesToShortTons(tonnes).toFixed(1)} tons`;
}

/** Whatever was stored, made safe to route on. */
export function normaliseProfile(stored) {
  const profile = { ...RV_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  profile.kind = profile.kind === 'rv' ? 'rv' : 'car';
  for (const [key, [low, high]] of Object.entries(RV_RANGES)) {
    const value = Number(profile[key]);
    profile[key] = Number.isFinite(value) && value >= low && value <= high
      ? value
      : RV_DEFAULTS[key];
  }
  return profile;
}

export const isRV = (profile) => normaliseProfile(profile).kind === 'rv';

/**
 * The costing this profile asks the router for.
 *
 * A car gets `auto` and no options, which is the same request the planner made
 * before any of this existed — so switching back to a car is a return to the
 * old behaviour rather than to a truck request with car-shaped numbers in it.
 */
export function routingFor(profile) {
  const vehicle = normaliseProfile(profile);
  if (vehicle.kind !== 'rv') return { costing: 'auto' };

  return {
    costing: 'truck',
    costing_options: {
      truck: {
        height: Number(vehicle.heightM.toFixed(2)),
        width: Number(vehicle.widthM.toFixed(2)),
        length: Number(vehicle.lengthM.toFixed(2)),
        weight: Number(vehicle.weightT.toFixed(2)),
        /*
         * Not hazmat, whatever is in the propane locker.
         *
         * The hazmat flag routes around tunnels and bridges closed to placarded
         * loads, which an RV is not. Setting it would send people the long way
         * round for no reason, and leaving it off is the correct answer rather
         * than an omission.
         */
        hazmat: false,
      },
    },
  };
}

/* ------------------------------------------------------------------ advisories */

/**
 * The standing caveat. Shown whenever a route was asked for as an RV, in full,
 * every time — not once on first use and not folded into a help page.
 *
 * Worded as the thing to do rather than as a disclaimer to dismiss. "Data may
 * be incomplete" is legally tidy and operationally useless; "your eyes and the
 * sign are the authority" is what actually keeps a roof on.
 */
export const RV_CAVEAT = 'Advisory only. The router avoids limits that are recorded in '
  + 'OpenStreetMap, and most low bridges, narrow tunnels and posted weight limits in the '
  + 'United States are not recorded there. A clear route is not a promise of clearance. '
  + 'Know your height, width, weight and length, and treat the sign at the structure as '
  + 'the authority — not this map.';

/**
 * What the router was actually told, spelled back out.
 *
 * The point is falsifiability. A panel saying "routed for your RV" cannot be
 * checked by the person reading it; a panel saying "13' 6\" high, 8' 6\" wide"
 * can be checked against the door sticker in about four seconds, which is when
 * a wrong number gets caught — before the trip rather than under the bridge.
 */
export function profileRows(profile, { metric = false } = {}) {
  const vehicle = normaliseProfile(profile);
  if (vehicle.kind !== 'rv') return [];
  return [
    ['Height', showDimension(vehicle.heightM, { metric })],
    ['Width', showDimension(vehicle.widthM, { metric })],
    ['Length', showDimension(vehicle.lengthM, { metric })],
    ['Weight', showWeight(vehicle.weightT, { metric })],
  ];
}

/**
 * What to say when a route fails under a profile that has dimensions on it.
 *
 * A refusal means something different for an RV than for a car, and the
 * difference is worth saying: for a car "no path" is usually a stop off the
 * road network, and for an RV it can be a real posted limit between two places
 * a car would drive between without noticing. Neither reading is certain, so
 * both are offered, in that order.
 */
export function explainFailure(message, profile) {
  const base = message || 'The routing service could not find a way between those stops.';
  if (!isRV(profile)) return base;
  return `${base} With a vehicle profile set, this can also mean a recorded limit on the `
    + 'direct route is smaller than your vehicle. Try again as a car to see whether a way '
    + 'exists at all — and if it does, something on it is posted against you.';
}
