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

test('byways: no classification field is written inline either', () => {
  /*
   * Same argument as the source-layer check above, and the same reason it has
   * to read the text: `['get', 'class']` inline is identical in output to
   * `['get', S.fields.classField]`, and correct against Mapbox. It is only
   * wrong under Protomaps, where the field is `kind` and asking for `class`
   * returns nothing - every road filtered out, an empty road network, no error.
   *
   * Twenty of these were inline before the seam. Missing one would leave a
   * single road class absent from the Protomaps map, which is exactly the kind
   * of gap nobody notices until they are looking for a road that is not there.
   */
  const source = readFileSync(path.join(HERE, '..', 'assets', 'js', 'lib', 'byways-style.js'), 'utf8');
  const inline = [...source.matchAll(/\['get', '(class|kind)'\]/g)].map((match) => match[0]);
  assert.deepEqual(inline, [],
    'a classification field is written inline; it must come from the schema');
});

test('byways: every layer draws from a source the schema names', () => {
  /*
   * The same seam, one level up. `source: 'composite'` inline is Mapbox's
   * source name; under Protomaps the source is called something else and a
   * layer pointing at a source that is not in the style is dropped by the
   * renderer without complaint.
   *
   * Checked in the output rather than the text this time, because unlike a
   * source-layer this one IS visible there: a layer naming a source the style
   * does not define is wrong under any schema.
   */
  const style = bywaysStyle('pk.snapshot');
  const defined = new Set(Object.keys(style.sources));
  const orphans = style.layers
    .filter((layer) => layer.source && !defined.has(layer.source))
    .map((layer) => `${layer.id} draws from ${layer.source}`);
  assert.deepEqual(orphans, [], 'a layer names a source the style never defines');
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


test('byways: the road hierarchy maps across, and says where it flattens', () => {
  /*
   * Eleven Mapbox classes, five Protomaps kinds. The mapping has to be total -
   * a class with no entry becomes `undefined` in a filter and matches nothing,
   * which removes a whole road class from the map without erroring.
   */
  assert.deepEqual(
    Object.keys(PROTOMAPS_SCHEMA.roadClasses).sort(),
    Object.keys(MAPBOX_SCHEMA.roadClasses).sort(),
    'the two schemas classify roads differently, so a class would go missing',
  );
  for (const [key, value] of Object.entries(PROTOMAPS_SCHEMA.roadClasses)) {
    assert.ok(typeof value === 'string' && value.length > 0, `${key} maps to nothing`);
  }

  // Mapbox maps each class to itself; anything else means the inline values
  // and the schema have drifted apart.
  for (const [key, value] of Object.entries(MAPBOX_SCHEMA.roadClasses)) {
    assert.ok(value.length > 0, `${key} has no Mapbox class`);
  }

  /*
   * And the loss is asserted rather than left as prose. Five distinct weights
   * become three, which is the difference between reading this map at speed
   * and squinting at it - recorded so that if kind_detail turns out to exist,
   * the improvement is visible as this number changing.
   */
  const distinct = new Set(Object.values(PROTOMAPS_SCHEMA.roadClasses)).size;
  const before = new Set(Object.values(MAPBOX_SCHEMA.roadClasses)).size;
  assert.equal(before, 11, 'Mapbox draws eleven distinguishable road classes');
  /*
   * Eleven, not five. Reading kind_detail rather than kind is what recovered
   * the six that the coarse field would have thrown away, and this number is
   * the whole reason that was worth chasing - if it drops back, the road
   * hierarchy has flattened and the map is worse in a way that is easy to
   * look at and not notice.
   */
  assert.equal(distinct, 11, 'the road hierarchy has flattened; roads must read kind_detail, not kind');
  assert.equal(PROTOMAPS_SCHEMA.fields.roadClassField, 'kind_detail');
});

/* ------------------------------------------------------- the Protomaps map */

const ARCHIVE = 'https://example.test/byways.pmtiles';
const protomapsStyle = () => bywaysStyle('', { schema: PROTOMAPS_SCHEMA, archive: ARCHIVE, maxzoom: 15 });

test('protomaps: no archive means no style, rather than a style of nothing', () => {
  /*
   * The same rule Mapbox-with-no-token follows, and for the same reason. A
   * style built with nowhere to read from validates, loads, reports success
   * and draws an empty parchment rectangle - the exact failure this file keeps
   * being written to avoid. Null sends the caller to the raster fallback,
   * which says out loud what it is showing instead.
   */
  assert.equal(bywaysStyle('', { schema: PROTOMAPS_SCHEMA }), null);
  assert.equal(bywaysStyle('', { schema: PROTOMAPS_SCHEMA, archive: '' }), null);
  assert.ok(protomapsStyle(), 'and an archive means there is one');
});

test('protomaps: the archive is addressed through the protocol', () => {
  const source = protomapsStyle().sources[PROTOMAPS_SCHEMA.source];
  assert.deepEqual(source.tiles, [`pmtiles://${ARCHIVE}/{z}/{x}/{y}`]);
  assert.equal(source.maxzoom, 15);
  assert.equal(source.type, 'vector');
  assert.ok(!source.url, 'a TileJSON url would be a second code path in the protocol handler');
});

test('protomaps: no Mapbox field name survives into the Protomaps style', () => {
  /*
   * The check that catches a frozen constant, which is a mistake this file has
   * now made four times.
   *
   * An expression written at module level is evaluated once, with whatever
   * schema is in force then - always Mapbox - so it bakes Mapbox field names
   * into every style built afterwards. The result validates, loads and draws;
   * the labels and the shields are simply absent. Nothing structural can see
   * it, because the layer is present and correct in every other respect.
   *
   * So the test is the direct one: these names exist only in Mapbox Streets,
   * and none of them may appear anywhere in a style built for another schema.
   */
  const text = JSON.stringify(protomapsStyle());
  const mapboxOnly = ['class', 'name_en', 'surface', 'reflen', 'shield', 'ele', 'index'];
  const found = mapboxOnly.filter((field) => text.includes(`"${field}"`));
  assert.deepEqual(found, [], 'a Mapbox field name reached the Protomaps style');
});

test('protomaps: the shield reads the network, and the number comes pre-stripped', () => {
  const shield = protomapsStyle().layers.find((layer) => layer.id === 'road-shield');
  const text = JSON.stringify(shield);
  assert.ok(text.includes('"network"'), 'the shield design must come from the network field');
  assert.ok(text.includes('"shield_text"'), 'and the number from shield_text, which is already stripped');
  assert.ok(text.includes('US:I') && text.includes('US:US'),
    'the interstate and US networks are what the design branches on');
});

test('protomaps: nothing is left pointing at Mapbox', () => {
  /*
   * The whole point of the archive is that looking at the map costs nothing
   * and works with no signal. One leftover Mapbox URL - a glyph range, a
   * sprite, a tile template - would quietly restore both the bill and the
   * dependency, and would do it invisibly, because the map would still draw.
   */
  const text = JSON.stringify(protomapsStyle());
  assert.ok(!text.includes('mapbox'), 'the Protomaps style still mentions Mapbox somewhere');
  assert.ok(!text.includes('access_token'), 'and still carries a token parameter');
});

test('protomaps: no layer is shipped with a source-layer the schema cannot supply', () => {
  /*
   * A source-layer of null is how the schema says "this source has no
   * contours". Left in the style, GL asks for a source-layer named `null`,
   * finds nothing, and draws nothing - no error, no warning, a map missing its
   * contour lines with no indication why. Those layers are meant to be dropped
   * before the style is handed over.
   */
  const style = protomapsStyle();
  const named = new Set(Object.values(PROTOMAPS_SCHEMA.layers).filter(Boolean));
  for (const layer of style.layers) {
    if (layer.type === 'background') continue;
    assert.ok(layer['source-layer'], `${layer.id} has no source-layer`);
    assert.ok(named.has(layer['source-layer']),
      `${layer.id} reads ${layer['source-layer']}, which the schema does not name`);
    assert.ok(style.sources[layer.source], `${layer.id} reads a source the style does not declare`);
  }
});

test('protomaps: what the schema cannot draw is dropped, and it is the expected list', () => {
  /*
   * Named rather than counted. "Seven fewer layers" passes just as happily if
   * the seven are the road classes, and the two gaps that matter - relief and
   * natural feature names - are ones we have answers for elsewhere: the USGS
   * contour and hillshade overlays are already in the catalogue.
   */
  const mapbox = new Set(bywaysStyle('pk.snapshot').layers.map((layer) => layer.id));
  const protomaps = new Set(protomapsStyle().layers.map((layer) => layer.id));
  const dropped = [...mapbox].filter((id) => !protomaps.has(id));
  assert.deepEqual(dropped.sort(), [
    'contour', 'contour-index', 'contour-label', 'hillshade',
    'label-summit', 'label-water', 'national-park',
    /*
     * The surface marking, which is the one that stings: "tracks and surfaces"
     * is how this basemap describes itself. Protomaps' schema does not name a
     * surface field, so the layer is dropped rather than drawn with a filter
     * that matches nothing - the loss is real either way and this way it is
     * visible. Whether the tiles carry surface after all is worth probing.
     */
    'road-unpaved',
    /*
     * The concurrency pair. Mapbox marks a road carrying two numbers in its
     * shield value, and that marker is what says the hyphen in "23-60" is a
     * separator rather than part of a number. Protomaps has no equivalent, so
     * the split does not run and a doubled road gets one shield - rather than
     * splitting on any hyphen, which would cut "21/2" and every hyphenated
     * forest road in half.
     */
    'road-shield-first', 'road-shield-second',
  ].sort());
  const added = [...protomaps].filter((id) => !mapbox.has(id));
  assert.deepEqual(added, [], 'the Protomaps style is the same map, not a different one');
});

test('protomaps: the road hierarchy keeps all eleven of its weights', () => {
  /*
   * This is the reason the port is worth doing at all. Protomaps' `kind` field
   * has five values and would have collapsed motorway into trunk and primary
   * into secondary - a US highway and a county road at the same weight. Roads
   * read `kind_detail` instead, which carries the original OSM tag.
   *
   * Checked by counting the distinct line widths the road layers actually draw,
   * not by counting the entries in the schema: a mapping with eleven names that
   * all resolve to the same weight would pass the second and fail the map.
   */
  const style = protomapsStyle();
  const widths = new Set(
    style.layers
      .filter((layer) => layer.id.startsWith('road-') && layer.type === 'line')
      .map((layer) => JSON.stringify(layer.paint['line-width'])),
  );
  assert.ok(widths.size >= 11, `the road network draws ${widths.size} distinct widths, expected at least 11`);
  assert.equal(new Set(Object.values(PROTOMAPS_SCHEMA.roadClasses)).size, 11);
});

test('protomaps: every road filter names a class the schema maps', () => {
  /*
   * A filter naming a value the tiles never carry is valid, compiles, and
   * draws an empty road class. There is nothing to see and nothing to report -
   * which is how `street` and `street_limited`, written out as Mapbox
   * literals among ten correct schema reads, survived until this ran.
   */
  const known = new Set([
    ...Object.values(PROTOMAPS_SCHEMA.roadClasses),
    ...Object.values(PROTOMAPS_SCHEMA.roadLinks),
  ]);
  const field = PROTOMAPS_SCHEMA.fields.roadClassField;
  const asked = new Set();
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    const reads = Array.isArray(node[1]) && node[1][0] === 'get' && node[1][1] === field;
    if ((node[0] === 'match' || node[0] === '==') && reads) {
      for (const value of node.slice(2).flat()) if (typeof value === 'string') asked.add(value);
    }
    for (const child of node) walk(child);
  };
  for (const layer of protomapsStyle().layers) {
    if (layer['source-layer'] !== PROTOMAPS_SCHEMA.layers.road) continue;
    walk(layer.filter);
    for (const value of Object.values(layer.paint || {})) walk(value);
    for (const value of Object.values(layer.layout || {})) walk(value);
  }
  assert.ok(asked.size > 0, 'no road filter reads the road class field at all');
  assert.deepEqual([...asked].filter((value) => !known.has(value)), [],
    'a road layer filters on a class the schema never maps');
});

test('byways: no road class is written inline', () => {
  /*
   * The third of these source checks, and the one that had to be written after
   * the fact. The source-layer and field checks above both passed while seven
   * road filters carried Mapbox class names spelled out - `street`,
   * `street_limited`, `track`, `path` - because those are values rather than
   * fields, and the output was correct against Mapbox either way.
   *
   * The reason it can only be checked here is the same as for the other two:
   * over Mapbox geometry the literal and the schema read produce identical
   * styles, so no test of behaviour can tell them apart.
   */
  const source = readFileSync(path.join(HERE, '..', 'assets', 'js', 'lib', 'byways-style.js'), 'utf8');
  const roads = source
    .slice(source.indexOf('function roadLayers'))
    // The accessors themselves name a class, which is the point of them; so
    // does `className === 'motorway'`, where the name is a key of ROAD_CLASSES
    // rather than a value from the tiles.
    .replace(/\bRL?\('[a-zA-Z]+'\)/g, 'R()')
    .replace(/className === '[a-z_]+'/g, 'className === K');
  const inline = [...roads.matchAll(/'(motorway|trunk|primary|secondary|tertiary|street|street_limited|track|path|pedestrian|service)(_link)?'/g)]
    .map((match) => match[0]);
  assert.deepEqual(inline, [],
    'a road class is written inline below roadLayers; it must come from the schema');
});
