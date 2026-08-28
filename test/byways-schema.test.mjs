/**
 * The cartography is ours; the geometry is rented. This pins the seam.
 *
 * Byways Topo read Mapbox Streets v8 directly - `source-layer: 'road'`,
 * `['get','class']` with Mapbox's own values - which is fine with one source
 * and becomes twenty-five scattered assumptions with two. Those names now live
 * in one schema object.
 *
 * The snapshot exists because that refactor had to be provably inert: the
 * whole generated style, compared byte for byte against what it produced
 * before the seam was cut. A port that quietly changes the map while claiming
 * to move it is the failure worth guarding against, and nothing smaller than
 * the whole document catches a single altered filter.
 *
 * When the Protomaps schema lands, this snapshot is what says the Mapbox one
 * still draws exactly what it always did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { bywaysStyle, MAPBOX_SCHEMA, PROTOMAPS_SCHEMA } from '../assets/js/lib/byways-style.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, 'fixtures', 'byways-style.snapshot.json');

test('byways: the Mapbox style is unchanged by the schema seam', () => {
  const expected = readFileSync(SNAPSHOT, 'utf8');
  const actual = `${JSON.stringify(bywaysStyle('pk.snapshot'), null, 1)}\n`;

  if (actual !== expected) {
    // Point at the first divergence rather than printing a megabyte of JSON.
    let at = 0;
    while (at < actual.length && actual[at] === expected[at]) at += 1;
    assert.fail(`the style changed at character ${at}\n`
      + `  expected: …${expected.slice(Math.max(0, at - 60), at + 60)}…\n`
      + `  actual:   …${actual.slice(Math.max(0, at - 60), at + 60)}…`);
  }
});

test('byways: every source-layer the style draws is named in the schema', () => {
  /*
   * The point of the seam is that nothing reaches past it. A literal left
   * inline would keep working against Mapbox and fail silently against
   * Protomaps - drawing nothing, which on a basemap looks like an empty
   * region rather than a bug.
   */
  const style = bywaysStyle('pk.snapshot');
  const known = new Set(Object.values(MAPBOX_SCHEMA.layers));
  const strays = style.layers
    .filter((layer) => layer['source-layer'] && !known.has(layer['source-layer']))
    .map((layer) => `${layer.id} reads ${layer['source-layer']}`);
  assert.deepEqual(strays, [], 'a source-layer is hard-coded rather than taken from the schema');
});

test('byways: no source-layer is written inline past the seam', () => {
  /*
   * A source check, deliberately, and worth defending because this file
   * otherwise argues against them.
   *
   * The property here IS about the source. `'source-layer': 'admin'` written
   * inline produces output identical to `S.layers.boundary` - the test above
   * cannot see it, and neither can any test of behaviour, because against
   * Mapbox the behaviour is correct. It only becomes wrong under a different
   * schema, where it silently draws nothing.
   *
   * So the rule being enforced is "do not inline the literal", which is a fact
   * about the text and can only be checked in the text.
   */
  const source = readFileSync(path.join(HERE, '..', 'assets', 'js', 'lib', 'byways-style.js'), 'utf8');
  const inline = [...source.matchAll(/'source-layer':\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(inline, [],
    'a source-layer is written inline; it must come from the schema so a second schema can replace it');
});

test('byways: the schema names a layer for everything the style needs', () => {
  // And the other direction: a name in the schema that nothing draws from is
  // dead weight the Protomaps mapping would have to account for anyway.
  const style = bywaysStyle('pk.snapshot');
  const used = new Set(style.layers.map((layer) => layer['source-layer']).filter(Boolean));
  const unused = Object.entries(MAPBOX_SCHEMA.layers)
    .filter(([, name]) => !used.has(name))
    .map(([key]) => key);
  assert.deepEqual(unused, [], 'the schema names source-layers the style never reads');
});


test('byways: the two schemas describe the same shape', () => {
  /*
   * A second schema is only useful if the style can read it the same way. The
   * keys have to line up exactly - a missing one reads as `undefined`, which
   * becomes `'source-layer': undefined` and draws nothing without erroring,
   * which is the failure this whole seam exists to prevent.
   *
   * `null` is the honest value for something a schema genuinely cannot supply,
   * and is what the style is expected to branch on. Absent is not the same as
   * null and must not be allowed to stand in for it.
   */
  assert.deepEqual(
    Object.keys(PROTOMAPS_SCHEMA.layers).sort(),
    Object.keys(MAPBOX_SCHEMA.layers).sort(),
    'the schemas name different sets of layers',
  );
  for (const key of Object.keys(MAPBOX_SCHEMA.fields)) {
    assert.ok(key in PROTOMAPS_SCHEMA.fields, `Protomaps does not say what it uses for ${key}`);
  }

  // Every value is a usable name or an explicit null; nothing is undefined.
  for (const [name, schema] of [['mapbox', MAPBOX_SCHEMA], ['protomaps', PROTOMAPS_SCHEMA]]) {
    for (const [key, value] of Object.entries({ ...schema.layers, ...schema.fields })) {
      assert.ok(value === null || (typeof value === 'string' && value.length > 0),
        `${name}.${key} is ${JSON.stringify(value)}, which is neither a name nor an honest null`);
    }
  }
});

test('byways: what Protomaps cannot draw is declared, not discovered', () => {
  /*
   * Recorded so the port cannot quietly lose them. Contours and hillshade have
   * no equivalent in this source; both are already available as overlays,
   * which is why the gap is acceptable rather than fatal.
   */
  assert.equal(PROTOMAPS_SCHEMA.layers.contour, null);
  assert.equal(PROTOMAPS_SCHEMA.layers.hillshade, null);
  assert.equal(PROTOMAPS_SCHEMA.reliefSource, null);

  // And the finding that made the shield port tractable: a network, not a shape.
  assert.equal(PROTOMAPS_SCHEMA.fields.shield, 'network');
  assert.equal(PROTOMAPS_SCHEMA.fields.shieldText, 'shield_text');
});
