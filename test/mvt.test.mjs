/**
 * Tests for the vector-tile reader in tools/inspect-archive.mjs.
 *
 * That tool exists to answer "the bytes arrived, so what is in them" when a
 * map draws the wrong thing. Which makes it a diagnostic, and a diagnostic
 * that is itself wrong is worse than none: it sends you looking in the wrong
 * place with confidence. So it is checked against tiles built here from the
 * protobuf spec, encoded by hand rather than by the same code reading them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeTile } from '../tools/inspect-archive.mjs';

/* ------------------------------------------------------- a protobuf writer */

const varint = (value) => {
  const out = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
};

const tag = (field, wire) => varint((field << 3) | wire);
const bytes = (field, payload) => [...tag(field, 2), ...varint(payload.length), ...payload];
const string = (field, value) => bytes(field, [...new TextEncoder().encode(value)]);
const number = (field, value) => [...tag(field, 0), ...varint(value)];

/** One layer: name, some features, its attribute keys and an extent. */
const layer = ({ name, features = 0, keys = [], extent = 4096 }) => bytes(3, [
  ...string(1, name),
  // A feature carrying a geometry, so it is length-delimited like a real one.
  ...Array.from({ length: features }, () => bytes(2, [...number(3, 2), ...bytes(4, [9, 0, 0])])).flat(),
  ...keys.flatMap((key) => string(3, key)),
  ...number(5, extent),
]);

const tile = (layers) => Uint8Array.from(layers.flatMap((one) => layer(one)));

/* -------------------------------------------------------------------- and */

test('mvt: a tile reports its layers, feature counts and keys', () => {
  const described = describeTile(tile([
    { name: 'roads', features: 3, keys: ['kind', 'kind_detail', 'name'] },
    { name: 'water', features: 1, keys: ['kind'] },
  ]));

  assert.deepEqual(described.map((one) => one.name), ['roads', 'water']);
  assert.deepEqual(described.map((one) => one.features), [3, 1]);
  assert.deepEqual(described[0].keys, ['kind', 'kind_detail', 'name']);
  assert.equal(described[0].extent, 4096);
});

test('mvt: a layer with no features is reported as empty, not as absent', () => {
  /*
   * The distinction the whole tool turns on. "roads:0" says the tile was cut
   * with a roads layer and nothing landed in it; no roads line at all says the
   * layer is not in the tileset. Those are different faults with different
   * fixes, and a reader that collapsed them would point at the wrong one.
   */
  const described = describeTile(tile([
    { name: 'landcover', features: 12 },
    { name: 'roads', features: 0 },
  ]));
  assert.deepEqual(described.map((one) => `${one.name}:${one.features}`), ['landcover:12', 'roads:0']);
});

test('mvt: an empty tile describes as nothing rather than throwing', () => {
  assert.deepEqual(describeTile(new Uint8Array(0)), []);
});

test('mvt: fields the reader does not use are skipped by length, not parsed', () => {
  /*
   * A real tile carries value tables, feature ids and a version — none of
   * which this reads. Skipping them wrongly does not fail loudly; it
   * desynchronises the cursor and every layer after the first comes back as
   * nonsense. So the fixture carries all four wire types around the parts that
   * matter.
   */
  const withNoise = Uint8Array.from([
    ...number(15, 2),                                  // version, a varint
    ...layer({ name: 'places', features: 2, keys: ['name'] }),
    ...tag(9, 5), 0, 0, 0, 0,                          // a 32-bit field
    ...tag(10, 1), 0, 0, 0, 0, 0, 0, 0, 0,             // a 64-bit field
    ...layer({ name: 'boundaries', features: 1 }),
  ]);
  assert.deepEqual(
    describeTile(withNoise).map((one) => `${one.name}:${one.features}`),
    ['places:2', 'boundaries:1'],
  );
});

/* -------------------------------------------------- and what they say --- */

const value = (field, payload) => bytes(4, [...(
  typeof payload === 'string' ? string(1, payload) : number(4, payload)
)]);

/** A layer whose features carry tags, so the key/value pairing can be checked. */
const tagged = ({ name, keys, values, features }) => bytes(3, [
  ...string(1, name),
  ...features.flatMap((tags) => bytes(2, [
    ...bytes(2, tags.flatMap((n) => varint(n))),
    ...number(3, 2),
    ...bytes(4, [9, 0, 0]),
  ])),
  ...keys.flatMap((key) => string(3, key)),
  ...values.flatMap((one) => value(4, one)),
  ...number(5, 4096),
]);

test('mvt: each key is paired with the values its features actually carry', () => {
  /*
   * The pairing is by index into two separate tables, and getting it backwards
   * produces output that looks entirely plausible — every value is a real
   * value and every key a real key, just attached to each other wrongly. Which
   * would be the worst possible failure in a tool whose whole job is settling
   * "does the style filter on what the tiles contain".
   */
  const [roads] = describeTile(Uint8Array.from(tagged({
    name: 'roads',
    keys: ['kind', 'kind_detail'],
    values: ['minor_road', 'residential', 'major_road', 'motorway'],
    features: [
      [0, 0, 1, 1],   // kind=minor_road  kind_detail=residential
      [0, 2, 1, 3],   // kind=major_road  kind_detail=motorway
    ],
  })));

  assert.equal(roads.features, 2);
  assert.deepEqual([...roads.seen.get('kind')].sort(), ['major_road', 'minor_road']);
  assert.deepEqual([...roads.seen.get('kind_detail')].sort(), ['motorway', 'residential']);
});

test('mvt: a key no feature uses does not appear as having values', () => {
  const [layer] = describeTile(Uint8Array.from(tagged({
    name: 'roads',
    keys: ['kind', 'surface'],
    values: ['minor_road'],
    features: [[0, 0]],
  })));
  assert.deepEqual([...layer.seen.get('kind')], ['minor_road']);
  assert.equal(layer.seen.has('surface'), false, 'declared but never used is not the same as used');
});

test('reconcile: a schema naming a value the tiles never carry is reported', async (t) => {
  /*
   * The one failure mode every other test in this repo is blind to, checked
   * on the tool that exists to see it.
   *
   * test/byways-schema.test.mjs says so in as many words: it reads the schema
   * for both sides of every comparison, so a schema naming a value the data
   * has never heard of is self-consistent and passes. That is not a
   * hypothetical - it shipped. `waterClasses` said lakes were `lake`;
   * Protomaps calls them `water`; every test passed and no lake on the map
   * ever had a name on it.
   *
   * So the reconciler is fed a tile whose water is tagged the way Protomaps
   * really tags it, and has to say that `lake` is named and absent and that
   * `stream` is present. Silenced console, because the point is the findings.
   */
  const { reconcile } = await import('../tools/inspect-archive.mjs');
  const { PROTOMAPS_SCHEMA } = await import('../assets/js/lib/byways-style.js');

  const said = [];
  const log = console.log;
  console.log = (...parts) => said.push(parts.join(' '));
  let findings;
  try {
    findings = reconcile([{
      name: PROTOMAPS_SCHEMA.layers.water,
      keys: ['kind'],
      seen: new Map([['kind', new Set(['water', 'stream', 'swimming_pool'])]]),
    }]);
  } finally {
    console.log = log;
  }

  const water = findings.find((one) => one.what === 'waterClasses');
  assert.ok(water, 'the water claim was not examined at all');
  assert.ok(water.unused.includes('lake'),
    'a value the schema names and the tile does not have must be reported');
  assert.ok(water.undrawn.includes('swimming_pool'),
    'a value the tile has and the schema does not name must be reported');

  // And the live schema has to be the corrected one: `water` present in both,
  // so it appears in neither list.
  assert.ok(!water.unused.includes('water') && !water.undrawn.includes('water'),
    'waterClasses must name `water`, which is how Protomaps tags a lake');

  t.diagnostic(`reported: ${said.length} lines`);
});

test('reconcile: a role naming several values is compared value by value', async () => {
  /*
   * The reconciler stringified an array instead of flattening it, and reported
   * both halves of a contradiction about a style that was correct:
   * "residential,unclassified" as a value the tile does not have, and
   * "residential" as a value the tile has that nothing names — two adjacent
   * lines disagreeing with each other.
   *
   * That is worse than not checking. A report that contradicts itself costs
   * whoever reads it the time to work out which half to believe, at the moment
   * they are already hunting something else.
   */
  const { reconcile } = await import('../tools/inspect-archive.mjs');
  const { PROTOMAPS_SCHEMA } = await import('../assets/js/lib/byways-style.js');

  const multi = Object.entries(PROTOMAPS_SCHEMA.roadClasses).find(([, value]) => Array.isArray(value));
  assert.ok(multi, 'no road role names several values, so there is nothing here to get wrong');
  const [, values] = multi;

  const log = console.log;
  console.log = () => {};
  let findings;
  try {
    findings = reconcile([{
      name: PROTOMAPS_SCHEMA.layers.road,
      keys: [PROTOMAPS_SCHEMA.fields.roadClassField],
      seen: new Map([[PROTOMAPS_SCHEMA.fields.roadClassField, new Set(values)]]),
    }]);
  } finally {
    console.log = log;
  }

  const roads = findings.find((one) => one.what === 'roadClasses');
  assert.ok(roads, 'the road claim was not examined');
  for (const value of values) {
    assert.ok(!roads.undrawn.includes(value),
      `"${value}" is named by the schema and must not be reported as undrawn`);
    assert.ok(!roads.unused.includes(value),
      `"${value}" is in the tile and must not be reported as absent`);
  }
  assert.ok(!roads.unused.some((one) => one.includes(',')),
    'a whole role was stringified instead of flattened');
});

test('reconcile: the road-name tally shows the names, and shows the name and not the kind', async () => {
  /*
   * "path  3 of 4 named" is a statistic, and the question it gets asked is not
   * a statistical one. Someone is standing on a trail looking at a map that
   * will not label it, and what they need to know is whether *that* trail is
   * one of the three. So the tally prints a few of the names.
   *
   * Which puts a second index in the loop, next to one that reads the same
   * arrays for the kind — and reading the kind's value where the name's
   * belongs would print `path` beside `path` and look entirely reasonable.
   * That is the mistake this test exists for, so it asserts the name is a
   * name: present, and not the class it is filed under.
   */
  const { reconcile } = await import('../tools/inspect-archive.mjs');
  const { PROTOMAPS_SCHEMA } = await import('../assets/js/lib/byways-style.js');
  const field = PROTOMAPS_SCHEMA.fields.roadClassField;
  const nameField = PROTOMAPS_SCHEMA.fields.name;

  const said = [];
  const log = console.log;
  console.log = (...parts) => said.push(parts.join(' '));
  try {
    reconcile([{
      name: PROTOMAPS_SCHEMA.layers.road,
      features: 2,
      keys: [field, nameField],
      /*
       * Deliberately arranged so no value sits at the index of the key that
       * points at it: with the name at values[2] and the name key at slot 1,
       * a loop that reads the key index where the value index belongs picks
       * up `track` and the test sees it. An earlier fixture had them lined
       * up, and the mutation it was written to catch passed.
       */
      values: ['path', 'track', 'Angel Windows Trail #218'],
      // kind_detail=path, name=Angel Windows Trail #218 — then an unnamed track.
      tags: [[0, 0, 1, 2], [0, 1]],
      seen: new Map([[field, new Set(['path', 'track'])]]),
    }]);
  } finally {
    console.log = log;
  }

  const row = said.find((line) => line.trim().startsWith('path '));
  assert.ok(row, `no tally line for paths in:\n${said.join('\n')}`);
  assert.match(row, /1 of 1 named/, 'the named count is wrong');
  assert.match(row, /Angel Windows Trail #218/, 'the name itself must be printed, not just counted');

  // The trap: the example must not be the value of the class field.
  const example = row.split('e.g.')[1]?.trim();
  assert.notEqual(example, 'path', 'that is the kind, printed where the name belongs');

  // And an unnamed kind stays quiet rather than inventing an example.
  const track = said.find((line) => line.trim().startsWith('track '));
  assert.ok(track && !track.includes('e.g.'), 'an unnamed kind should offer no example');
});
