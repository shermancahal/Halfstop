import test from 'node:test';
import assert from 'node:assert/strict';

import {
  lunarEclipses, eclipseAtLunation, describeEclipse, shadowGeometry,
} from '../assets/js/lib/eclipse.js';

const iso = (date) => date.toISOString().slice(0, 16);
const minutesApart = (a, b) => Math.abs(a.getTime() - b.getTime()) / 60000;

/*
 * The published catalogue, which is the only thing worth checking against.
 *
 * Eclipse circumstances are known decades ahead and do not change, so these
 * are fixed facts rather than a snapshot of current behaviour: if a change to
 * the arithmetic moves any of them, the arithmetic is wrong.
 *
 * Times are greatest eclipse in UTC. A tolerance of two minutes is generous
 * for the method and tight enough that a broken term cannot hide — dropping a
 * single correction moves these by tens of minutes.
 */
const KNOWN = [
  { when: '2025-03-14T06:59', kind: 'total' },
  { when: '2025-09-07T18:12', kind: 'total' },
  { when: '2026-03-03T11:34', kind: 'total' },
  { when: '2026-08-28T04:13', kind: 'partial' },
  { when: '2027-02-20T23:13', kind: 'penumbral' },
  // Two penumbrals in 2027, and leaving this one out of the table was the
  // table's mistake rather than the arithmetic's: it shifted every later entry
  // by one and reported a 147-day error.
  { when: '2027-08-17T07:14', kind: 'penumbral' },
  { when: '2028-01-12T04:13', kind: 'partial' },
];

test('the published eclipses come back, at the published times', () => {
  const found = lunarEclipses(new Date('2025-01-01T00:00:00Z'), { count: KNOWN.length });
  assert.equal(found.length, KNOWN.length);

  for (const [index, expected] of KNOWN.entries()) {
    const actual = found[index];
    const drift = minutesApart(actual.greatest, new Date(`${expected.when}:00Z`));
    assert.ok(drift <= 2,
      `${expected.when}: computed ${iso(actual.greatest)}, ${drift.toFixed(1)} minutes out`);
    assert.equal(actual.kind, expected.kind, `${expected.when} should be ${expected.kind}`);
  }
});

test('a total eclipse is deeper than a partial, which is deeper than a penumbral', () => {
  const found = lunarEclipses(new Date('2025-01-01T00:00:00Z'), { count: 6 });
  const total = found.find((e) => e.kind === 'total');
  const partial = found.find((e) => e.kind === 'partial');
  const penumbral = found.find((e) => e.kind === 'penumbral');

  assert.ok(total.umbralMagnitude >= 1, 'a total eclipse covers the whole disc');
  assert.ok(partial.umbralMagnitude > 0 && partial.umbralMagnitude < 1);
  assert.ok(penumbral.umbralMagnitude <= 0, 'a penumbral one never reaches the umbra');
});

test('the phases nest: totality inside partial inside penumbral', () => {
  const [total] = lunarEclipses(new Date('2025-08-01T00:00:00Z'), { count: 1 });
  assert.equal(total.kind, 'total');
  assert.ok(total.penumbral.from < total.partial.from);
  assert.ok(total.partial.from < total.total.from);
  assert.ok(total.total.to < total.partial.to);
  assert.ok(total.partial.to < total.penumbral.to);
});

test('September 2025 keeps its long totality', () => {
  // 82 minutes, one of the longest this decade — a duration that falls out of
  // gamma, so it is a sharp check that the geometry and not just the timing is
  // right.
  const [eclipse] = lunarEclipses(new Date('2025-09-01T00:00:00Z'), { count: 1 });
  assert.ok(Math.abs(eclipse.total.minutes - 82) < 4,
    `totality computed as ${eclipse.total.minutes.toFixed(0)} minutes`);
});

test('the August 2026 partial is about 93% covered', () => {
  const [eclipse] = lunarEclipses(new Date('2026-08-01T00:00:00Z'), { count: 1 });
  assert.equal(eclipse.kind, 'partial');
  assert.ok(Math.abs(eclipse.umbralMagnitude - 0.93) < 0.02,
    `magnitude computed as ${eclipse.umbralMagnitude.toFixed(3)}`);
  assert.equal(eclipse.total, null, 'a partial eclipse has no totality');
});

test('most full moons are not eclipses at all', () => {
  // The gate on the argument of latitude is what keeps a scan over years
  // cheap. If it ever stopped rejecting, every full moon would come back as an
  // eclipse and the panel would be nonsense rather than empty.
  let eclipses = 0;
  for (let k = 300; k < 350; k += 1) if (eclipseAtLunation(k + 0.5)) eclipses += 1;
  assert.ok(eclipses > 0, 'some of fifty full moons are eclipses');
  assert.ok(eclipses < 20, `${eclipses} of fifty is far too many`);
});

test('an eclipse already under way is still the next one', () => {
  // Asked from the middle of the September 2025 totality: an eclipse you are
  // standing outside watching should not be reported as one that has passed.
  const [eclipse] = lunarEclipses(new Date('2025-09-07T18:10:00Z'), { count: 1 });
  assert.equal(iso(eclipse.greatest).slice(0, 10), '2025-09-07');
});

test('and one that has finished is not', () => {
  const [eclipse] = lunarEclipses(new Date('2025-09-08T00:00:00Z'), { count: 1 });
  assert.notEqual(iso(eclipse.greatest).slice(0, 10), '2025-09-07');
});

test('a whole-number lunation is refused rather than answered wrongly', () => {
  // Whole k is a NEW moon. Meeus's lunar formulae applied there compute a
  // solar eclipse's geometry with the wrong constants, which would be silently
  // wrong rather than an error — so the gate has to reject it on its own.
  for (let k = 300; k < 340; k += 1) {
    assert.throws(() => eclipseAtLunation(k), /lunation plus a half/,
      `new moon ${k} was answered instead of refused`);
  }
  /*
   * And the half still works, so the guard is not simply refusing everything.
   * Scanned over a range rather than sampled: only a couple of full moons a
   * year are eclipses, so three arbitrary ones being null proves nothing.
   */
  let answered = 0;
  for (let k = 300; k < 340; k += 1) if (eclipseAtLunation(k + 0.5)) answered += 1;
  assert.ok(answered > 0, 'the guard rejected every full moon too');
});

test('each kind is described in words, not numbers', () => {
  const found = lunarEclipses(new Date('2025-01-01T00:00:00Z'), { count: 6 });
  for (const eclipse of found) {
    const text = describeEclipse(eclipse);
    assert.ok(text.length > 40, `${eclipse.kind} has no description`);
    assert.ok(!/\bNaN\b|undefined/.test(text), text);
  }
  assert.match(describeEclipse(found.find((e) => e.kind === 'total')), /copper|red/i);
});

/*
 * The picture has to agree with the physics.
 *
 * The first version of the diagram used Meeus's contact distances as the
 * shadow radii. Those already contain a moon radius each — it is why magnitude
 * divides by 0.5450, a moon diameter — so both circles came out one moon too
 * big and the August 2026 partial drew as a total: the moon sat comfortably
 * inside an umbra it actually pokes out of. It looked entirely plausible,
 * which is the reason this is checked in arithmetic rather than by eye.
 */
test('a total eclipse draws with the moon fully inside the umbra', () => {
  const total = lunarEclipses(new Date('2025-09-01T00:00:00Z'), { count: 1 })[0];
  const { moon, umbra, offset } = shadowGeometry(total);
  assert.ok(offset + moon <= umbra,
    `moon reaches ${(offset + moon).toFixed(3)}, umbra is ${umbra.toFixed(3)}`);
});

test('a partial draws with the moon straddling the umbra edge', () => {
  const partial = lunarEclipses(new Date('2026-08-01T00:00:00Z'), { count: 1 })[0];
  const { moon, umbra, offset } = shadowGeometry(partial);
  assert.ok(offset + moon > umbra, 'part of the moon must stick out of the umbra');
  assert.ok(offset - moon < umbra, 'and part of it must be inside');
});

test('a penumbral draws with the moon clear of the umbra entirely', () => {
  const penumbral = lunarEclipses(new Date('2027-01-01T00:00:00Z'), { count: 1 })[0];
  assert.equal(penumbral.kind, 'penumbral');
  const { moon, umbra, penumbra, offset } = shadowGeometry(penumbral);
  assert.ok(offset - moon > umbra, 'no part of the moon may touch the umbra');
  assert.ok(offset - moon < penumbra, 'but it must be inside the penumbra');
});
