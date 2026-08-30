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
  /*
   * A role may name one value or several. Protomaps splits some of what Mapbox
   * groups - a street there is `residential` and `unclassified`, a path is five
   * separate kinds - so the shape is string-or-array, and what has to hold is
   * that every role resolves to at least one non-empty value. A role that
   * resolves to nothing becomes `undefined` in a filter and removes a whole
   * road class from the map without erroring.
   */
  for (const [key, value] of Object.entries(PROTOMAPS_SCHEMA.roadClasses)) {
    const values = [].concat(value);
    assert.ok(values.length > 0, `${key} maps to nothing`);
    for (const one of values) {
      assert.ok(typeof one === 'string' && one.length > 0, `${key} maps to something that is not a class name`);
    }
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
  const distinct = new Set(Object.values(PROTOMAPS_SCHEMA.roadClasses).flat()).size;
  const before = new Set(Object.values(MAPBOX_SCHEMA.roadClasses).flat()).size;
  assert.equal(before, 11, 'Mapbox draws eleven distinguishable road classes');
  /*
   * Eleven, not five. Reading kind_detail rather than kind is what recovered
   * the six that the coarse field would have thrown away, and this number is
   * the whole reason that was worth chasing - if it drops back, the road
   * hierarchy has flattened and the map is worse in a way that is easy to
   * look at and not notice.
   */
  /*
   * Sixteen now, not eleven. The five added are `unclassified`, `footway`,
   * `bridleway`, `steps` and `cycleway`, and none of them came from reading
   * the documentation - they came from reading a real tile and asking which
   * of its values this style never mentions. Every one of them was drawing
   * nothing.
   *
   * Pinned exactly rather than as a floor, for the same reason it was pinned
   * at eleven: this number going down is the road hierarchy flattening, which
   * is easy to look at and not notice.
   */
  assert.equal(distinct, 16, 'the road hierarchy has flattened; roads must read kind_detail, not kind');
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
    'label-summit',
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
    ...Object.values(PROTOMAPS_SCHEMA.roadClasses).flat(),
    ...Object.values(PROTOMAPS_SCHEMA.roadLinks).flat(),
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

test('protomaps: every class the schema maps is drawn by some layer', () => {
  /*
   * The other direction, and the one that was only ever checked in CI.
   *
   * tools/validate-style.mjs has had both directions for a while, but it needs
   * @mapbox/mapbox-gl-style-spec installed, so it runs only on a runner - and
   * `npm test` runs with nothing installed, which is the point of it. The
   * result was two implementations of the same check with one of them
   * unreachable locally: adding a second value to a road role passed every
   * test here and broke the deploy, because the validator was still comparing
   * an array against the strings a filter asks for.
   *
   * This direction is the one that matters most anyway. A class the schema
   * maps and no layer draws is a whole road type absent from the map, and
   * nothing about the style is invalid - so the only symptom is roads that are
   * not there, which is what half of today has been about.
   */
  const mapped = new Set([
    ...Object.values(PROTOMAPS_SCHEMA.roadClasses).flat(),
    ...Object.values(PROTOMAPS_SCHEMA.roadLinks).flat(),
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
  assert.deepEqual([...mapped].filter((value) => !asked.has(value)), [],
    'the schema maps a road class that no layer draws, so it is invisible');
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
    // `classes('street', 'track')` names roles, not tile values - the same
    // exemption R() and RL() get, for the same reason.
    .replace(/\bclasses\((?:\s*'[a-zA-Z]+'\s*,?)+\)/g, 'classes()')
    .replace(/className === '[a-z_]+'/g, 'className === K');
  const inline = [...roads.matchAll(/'(motorway|trunk|primary|secondary|tertiary|street|street_limited|track|path|pedestrian|service)(_link)?'/g)]
    .map((match) => match[0]);
  assert.deepEqual(inline, [],
    'a road class is written inline below roadLayers; it must come from the schema');
});

test('protomaps: protected ground is drawn, and more of it than Mapbox names', () => {
  /*
   * Mapbox's landuse_overlay distinguishes exactly one kind of protected
   * ground: national_park. Protomaps separates national_park, protected_area,
   * nature_reserve and forest, and on a back-roads map the last two are most
   * of the ground the roads are actually in — a national forest drawn as bare
   * parchment is the map failing at its own subject.
   *
   * Read from Protomaps' own park layer, which names "source-layer": "landuse"
   * and filters on kind. The documentation could not answer it: its kinds
   * section is one flat alphabetical list with no layer column.
   */
  const park = protomapsStyle().layers.find((layer) => layer.id === 'national-park');
  assert.ok(park, 'the park fill must be drawn under Protomaps too');
  assert.equal(park['source-layer'], 'landuse');
  const text = JSON.stringify(park.filter);
  for (const kind of ['national_park', 'protected_area', 'nature_reserve', 'forest']) {
    assert.ok(text.includes(kind), `${kind} is protected ground and must be drawn`);
  }
  assert.ok(text.includes('"kind"'), 'and it reads the schema\'s own classification field');
});

test('byways: the Mapbox park fill still draws exactly what it drew', () => {
  // The one deliberate change to the Mapbox style in the whole port, and it is
  // output-identical: `==` on one value became `match` on a list, so a schema
  // naming four kinds can use the same expression. Pinned rather than trusted.
  const park = bywaysStyle('pk.snapshot').layers.find((layer) => layer.id === 'national-park');
  assert.equal(park['source-layer'], 'landuse_overlay');
  assert.deepEqual(park.filter, ['match', ['get', 'class'], ['national_park'], true, false]);
});

test('protomaps: named water is labelled, from the water features themselves', () => {
  /*
   * Mapbox keeps the names of natural features in their own layer; Protomaps
   * puts the names of lakes and rivers on the water polygons. Read from its
   * own style, whose water_label_ocean and water_label_lakes both declare
   * "source-layer": "water" — not guessed from the absence of anything better.
   */
  const label = protomapsStyle().layers.find((layer) => layer.id === 'label-water');
  assert.ok(label, 'water names must be drawn');
  assert.equal(label['source-layer'], 'water');
  const text = JSON.stringify(label.filter);
  for (const kind of ['ocean', 'lake', 'river']) assert.ok(text.includes(kind), kind);
  assert.ok(!text.includes('playa'), 'a dry lake bed labelled as water is worse than not labelling it');
  assert.ok(text.includes('"has"'), 'and only where there is a name — most water carries none');
});

test('protomaps: no layer filters on a class the schema never names', () => {
  /*
   * The general form of the road check, which found seven values and stopped
   * at roads because roads were where the work was. Every other layer
   * classifies through the same field, and three more were still spelling out
   * Mapbox's vocabulary when this was widened: the landcover ramp, the landuse
   * fill and the place-label sizing.
   *
   * The consequence is not an error. It is a uniform green country with every
   * town's name in the same small type - which looks like a palette decision,
   * and is why this needs a check rather than a look.
   *
   * What it cannot do, said plainly because the name suggests otherwise: it
   * reads the schema for both sides, so it catches a literal written inline
   * that the schema does not name, and it cannot catch the schema naming the
   * wrong value. Changing `locality` to `settlement` in the schema passes this
   * test and draws nothing. Only reading Protomaps' own style settles that,
   * which is what the pm: probes in tools/layer-candidates.json are for.
   */
  const known = new Set([
    ...Object.values(PROTOMAPS_SCHEMA.landcover || {}).flat(),
    ...Object.values(PROTOMAPS_SCHEMA.landuse || {}).flat(),
    ...Object.values(PROTOMAPS_SCHEMA.place || {}).flat(),
    ...Object.values(PROTOMAPS_SCHEMA.boundaryClasses || {}).flat(),
    ...PROTOMAPS_SCHEMA.protectedClasses,
    ...PROTOMAPS_SCHEMA.waterClasses,
    ...PROTOMAPS_SCHEMA.summitClasses,
  ]);
  const field = PROTOMAPS_SCHEMA.fields.classField;
  const strays = [];
  const walk = (node, id) => {
    if (!Array.isArray(node)) return;
    const reads = Array.isArray(node[1]) && node[1][0] === 'get' && node[1][1] === field;
    if ((node[0] === 'match' || node[0] === '==') && reads) {
      for (const value of node.slice(2).flat()) {
        // Colours sit in the same arms as the values they answer for.
        if (typeof value === 'string' && !value.startsWith('#') && !known.has(value)) {
          strays.push(`${id}: ${value}`);
        }
      }
    }
    for (const child of node) walk(child, id);
  };
  for (const layer of protomapsStyle().layers) {
    if (layer['source-layer'] === PROTOMAPS_SCHEMA.layers.road) continue;
    walk(layer.filter, layer.id);
    for (const value of Object.values(layer.paint || {})) walk(value, layer.id);
    for (const value of Object.values(layer.layout || {})) walk(value, layer.id);
  }
  assert.deepEqual(strays, [], 'a layer filters on a value the tiles do not carry');
});

test('byways: a role a schema has no values for draws no arm', () => {
  /*
   * Three of the seven ground-cover roles exist only in Protomaps: cropland,
   * bare rock and cities. Mapbox has no values for them, and the alternative to
   * omitting the arm is an empty match branch — which the spec rejects — or a
   * branch listing a value the tiles never carry, which is valid and dead.
   *
   * Checked in both directions, because "the arm is missing" and "the arm is
   * there" are the two halves of one claim.
   */
  const colourOf = (style) => JSON.stringify(
    style.layers.find((layer) => layer.id === 'landcover').paint['fill-color'],
  );
  const mapbox = colourOf(bywaysStyle('pk.snapshot'));
  const protomaps = colourOf(protomapsStyle());

  assert.ok(!mapbox.includes('urban_area'), 'Mapbox has no urban_area, so it must not name one');
  assert.ok(!mapbox.includes('farmland'), 'nor farmland');
  assert.ok(protomaps.includes('urban_area'), 'Protomaps does, so it must');
  assert.ok(protomaps.includes('farmland'), 'and cropland is not forest green');
  assert.ok(protomaps.includes('barren'), 'nor is bare rock');
});

test('byways: the basemap row says the thing a reader can act on', async () => {
  /*
   * The first version of this said "Drawing from Mapbox — metered, and cannot
   * be taken offline", and the report back was a question: what does that
   * mean? Which is the answer. It was two facts stapled together, one written
   * in the vocabulary of whoever pays the bill, in a list read mostly by
   * people who do not.
   *
   * So: everyone is told whether the map can be taken with them, in the words
   * the download button uses. Where the geometry comes from goes to editors,
   * who are the ones comparing the two sources.
   */
  const { sourceNoteFor } = await import('../assets/js/lib/engine.js');
  const byways = { custom: 'byways' };
  const mapbox = { custom: 'byways-mapbox' };
  const archive = 'https://x/y.pmtiles';

  assert.equal(sourceNoteFor(byways, { archive, token: 'pk.x' }), 'Can be downloaded for offline use.');
  assert.equal(sourceNoteFor(byways, { archive: '', token: 'pk.x' }), 'Cannot be downloaded for offline use.');

  // No jargon reaches a reader who is not running the thing.
  for (const options of [{ archive, token: 'pk.x' }, { archive: '', token: 'pk.x' }]) {
    const text = sourceNoteFor(byways, options);
    assert.doesNotMatch(text, /metered|bills|Mapbox|Protomaps|archive/i, text);
  }

  // An editor gets the provenance, and still gets the part everyone gets.
  const asEditor = { archive: '', token: 'pk.x', editor: true };
  assert.match(sourceNoteFor(byways, asEditor), /Mapbox/);
  assert.match(sourceNoteFor(byways, asEditor), /Cannot be downloaded/);
  assert.match(sourceNoteFor(byways, { archive, token: 'pk.x', editor: true }), /own map archive/);

  // The Mapbox twin never follows the switch — it is the comparison.
  assert.equal(sourceNoteFor(mapbox, { archive, token: 'pk.x' }), 'Cannot be downloaded for offline use.');

  /*
   * Silent where neither source is configured, rather than explaining the
   * substitution twice: the panel already carries a banner about it, and two
   * accounts of the same fact in one card is how a reader learns to skip both.
   */
  assert.equal(sourceNoteFor(byways, { archive: '', token: '' }), '');
  assert.equal(sourceNoteFor(byways, { archive: '', token: '', editor: true }), '');

  // And a basemap with one source says nothing, rather than a sentence on
  // every row in the list.
  assert.equal(sourceNoteFor({ id: 'usgs-topo' }, { archive, token: 'pk.x' }), '');
  assert.equal(sourceNoteFor(null), '');
});

test('byways: the font stack follows the schema, because the glyph server does', () => {
  /*
   * The fault that made the Protomaps map look broken, and the one the
   * "no Mapbox field name survives" check could not see.
   *
   * `text-font` is not a field name and not a source-layer, so every existing
   * check walked straight past it - and it was a module-level constant, which
   * is the frozen-at-import mistake this file has caught three times in other
   * shapes. The result was Mapbox's font names asked of Protomaps' font
   * server, a 404 on every glyph range, and a map that drew water, parks and
   * roads with not one label, road name or route number on it.
   *
   * This asserts the whole property rather than the one symptom: whatever
   * fonts a style ships, all of them must come from the schema that built it.
   * Written that way it fails on a reverted constant, on a stack half-ported,
   * and on a new symbol layer that hardcodes a font - three ways of making the
   * same mistake, one of which has already happened.
   */
  for (const [what, style, schema] of [
    ['mapbox', bywaysStyle('tok'), MAPBOX_SCHEMA],
    ['protomaps', protomapsStyle(), PROTOMAPS_SCHEMA],
  ]) {
    const allowed = new Set([...schema.font, ...schema.fontBold]);
    const symbols = style.layers.filter((layer) => layer.layout?.['text-font']);
    // Protomaps ships fewer label layers than Mapbox - summits and named
    // natural features are dropped, because that schema has nowhere to read
    // them from - so the guard is only against a vacuous loop, and both
    // weights are required so neither stack goes unexercised.
    assert.ok(symbols.length >= 4, `${what}: expected the label layers to be present`);
    const asked = new Set(symbols.flatMap((layer) => layer.layout['text-font']));
    assert.ok(asked.has(schema.font[0]), `${what}: nothing uses the regular stack`);
    assert.ok(asked.has(schema.fontBold[0]), `${what}: nothing uses the bold stack`);
    for (const layer of symbols) {
      for (const name of layer.layout['text-font']) {
        assert.ok(allowed.has(name), `${what}: ${layer.id} asks for "${name}", which ${schema.id} does not name`);
      }
    }
  }
});

test('byways: the Protomaps font names are the ones that server actually has', () => {
  /*
   * A pin, deliberately, on values that were measured rather than reasoned.
   *
   * protomaps.github.io/basemaps-assets serves Noto Sans Regular, Medium and
   * Italic, and answers 404 for "Noto Sans Bold" - which is why the bold stack
   * is Medium and looks like a typo. The probes are in
   * tools/layer-candidates.json under `font:`, and they are the only reason
   * these three strings are right.
   *
   * The test cannot check the server; it has no network. What it can do is
   * make changing these a deliberate act rather than a tidy-up, which is
   * exactly what "Bold" would look like to anyone reading the line.
   */
  assert.deepEqual(PROTOMAPS_SCHEMA.font, ['Noto Sans Regular']);
  assert.deepEqual(PROTOMAPS_SCHEMA.fontBold, ['Noto Sans Medium'],
    'Noto Sans Bold does not exist on that server; Medium is the bold weight it has');

  // And the fonts have to be reachable from the glyphs URL the style ships.
  assert.match(protomapsStyle().glyphs, /^https:\/\/protomaps\.github\.io\/basemaps-assets\/fonts\//);
});

test('byways: no font name is written inline past the seam', () => {
  /*
   * The source-text half, same as the source-layer and class checks above.
   *
   * A style built from the right schema and a style with the names inlined are
   * identical documents under Mapbox, so only reading the file catches the
   * second one. The schema definitions are where these strings belong; nothing
   * below them may repeat one.
   */
  const source = readFileSync(path.join(HERE, '..', 'assets', 'js', 'lib', 'byways-style.js'), 'utf8');
  const seam = source.indexOf('function buildStyle');
  assert.ok(seam > 0, 'the style builder moved; this check needs its new name');

  const past = source.slice(seam);
  for (const name of [...MAPBOX_SCHEMA.font, ...MAPBOX_SCHEMA.fontBold,
    ...PROTOMAPS_SCHEMA.font, ...PROTOMAPS_SCHEMA.fontBold]) {
    assert.ok(!past.includes(`'${name}'`), `"${name}" is written inline past the seam`);
  }
});

test('byways: a layer never draws geometry it cannot draw', () => {
  /*
   * A fill layer handed a LineString does not skip it. It closes the ring from
   * the last vertex back to the first and fills the result - so a river comes
   * out as an enormous wedge with one edge following the water and the other a
   * dead-straight chord across several miles of hillside. That was reported,
   * over the Little River, and it is the whole of this test.
   *
   * The cause is a seam problem rather than a data problem, which is why no
   * existing check saw it. Mapbox keeps water bodies and watercourses in
   * separate source-layers, so a fill over one and a line over the other each
   * get exactly the geometry they can draw and no filter was ever needed.
   * Protomaps puts both in `water`. Every field name was right, every value
   * was right, and the map was wrong.
   *
   * So the rule is stated as a property of any schema, present or future:
   * wherever a fill layer and a line layer read the same source-layer, both
   * must say which geometry they are for. That fails on this bug, on the same
   * bug in the line direction, and on a third foundation arriving with the
   * same shape - rather than pinning the one filter that happens to fix today.
   */
  for (const [what, style] of [['mapbox', bywaysStyle('tok')], ['protomaps', protomapsStyle()]]) {
    const byLayer = new Map();
    for (const layer of style.layers) {
      if (!layer['source-layer']) continue;
      if (!byLayer.has(layer['source-layer'])) byLayer.set(layer['source-layer'], []);
      byLayer.get(layer['source-layer']).push(layer);
    }

    for (const [sourceLayer, layers] of byLayer) {
      const fills = layers.filter((layer) => layer.type === 'fill');
      const lines = layers.filter((layer) => layer.type === 'line');
      if (!fills.length || !lines.length) continue;

      /*
       * Both kinds read this source-layer, so neither may take it all. A
       * `filter` mentioning geometry-type anywhere counts: some layers narrow
       * by class as well, and the shape of that expression is not this test's
       * business.
       */
      const saysGeometry = (layer) => JSON.stringify(layer.filter ?? null).includes('geometry-type');
      for (const layer of [...fills, ...lines]) {
        assert.ok(saysGeometry(layer),
          `${what}: ${layer.id} is a ${layer.type} over "${sourceLayer}", which also carries `
          + `${layer.type === 'fill' ? 'lines' : 'fills'}; it must say which geometry it draws`);
      }
    }
  }
});

test('protomaps: every field the style reads is one the schema declares', () => {
  /*
   * The gap the "no Mapbox field name survives" check could not see.
   *
   * That one walks the Protomaps style looking for the *values* of
   * MAPBOX_SCHEMA.fields — so it catches `class` where `kind` belongs. It is
   * blind to a field name that appears in neither schema, and two did:
   * `admin_level` and `maritime`, written inline in the boundary filters
   * because Mapbox's admin layer has them and nobody re-read those two layers
   * when the seam was cut.
   *
   * What that cost was not subtle. `['get', 'admin_level']` on a Protomaps
   * boundary is null, `['<=', null, 0]` logs "Expected value to be of type
   * number, but found null instead" once per tile, and both boundary layers
   * drew nothing at all — no state line and no national border, anywhere on
   * the map, at any zoom.
   *
   * So this asserts the whole property instead: every field the Protomaps
   * style reads is either one the schema declares or one of a short list of
   * names that belong to the app rather than the tiles. A new layer reading a
   * field nobody declared fails here, whatever schema it was borrowed from.
   */
  const declared = new Set(Object.values(PROTOMAPS_SCHEMA.fields).filter(Boolean));

  /*
   * Names the app puts on its own features, which never come from an archive.
   * Listed rather than pattern-matched, so adding one is a decision.
   */
  const ours = new Set(['index', 'ele']);

  const read = new Map();
  const walk = (node, id) => {
    if (!Array.isArray(node)) return;
    /*
     * `has` as well as `get`. The first version of this walked only `get`,
     * and `['has', 'name']` was sitting in two filters at the time — correct
     * under both schemas by luck, since they happen to agree on that one
     * field, and exactly the kind of luck that runs out when a third arrives.
     */
    if ((node[0] === 'get' || node[0] === 'has') && typeof node[1] === 'string') {
      if (!read.has(node[1])) read.set(node[1], id);
    }
    for (const child of node) walk(child, id);
  };
  for (const layer of protomapsStyle().layers) {
    walk(layer.filter, layer.id);
    for (const value of Object.values(layer.paint || {})) walk(value, layer.id);
    for (const value of Object.values(layer.layout || {})) walk(value, layer.id);
  }

  assert.ok(read.size > 0, 'the style reads no fields at all, which cannot be right');
  const strays = [...read].filter(([field]) => !declared.has(field) && !ours.has(field))
    .map(([field, id]) => `${id} reads "${field}"`);
  assert.deepEqual(strays, [],
    'a layer reads a field the Protomaps schema does not declare; it will come back null');
});
