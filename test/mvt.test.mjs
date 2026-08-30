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
