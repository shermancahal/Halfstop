/**
 * Tests for the parsing and measurement core — the code the viewer and the
 * catalogue builder both depend on. Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseXML, childText, findDescendants, decodeEntities } from '../assets/js/lib/xml.js';
import { parseGPX } from '../assets/js/lib/gpx.js';
import { parseKML } from '../assets/js/lib/kml.js';
import { parseMapFile, summarize, findLinks, findLink, findLinkSpans } from '../assets/js/lib/parse.js';
import { iconForSymbol } from '../assets/js/lib/pin-icons.js';
import { extractKMLFromKMZ } from '../assets/js/lib/kmz.js';
import {
  haversine, lineLength, elevationChange, simplify, boundsAreValid,
  mergeBounds, formatDistance, formatElevation, formatDuration,
} from '../assets/js/lib/geo.js';

/* ------------------------------------------------------------------ XML */

test('xml: decodes named, decimal and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b &#65; &#x42;'), 'a & b A B');
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays');
});

test('xml: handles CDATA, comments, declarations and doctypes', () => {
  const doc = parseXML(`<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x "y">]>
    <t><!-- ignored --><a><![CDATA[raw <b> text]]></a></t>`);
  assert.equal(childText(findDescendants(doc, 't')[0], 'a'), 'raw <b> text');
});

test('xml: attribute quoting styles and self-closing tags', () => {
  const doc = parseXML(`<r><p a="1" b='2' c=3 /><p a="quoted > gt"/></r>`);
  const ps = findDescendants(doc, 'p');
  assert.equal(ps.length, 2);
  assert.deepEqual(ps[0].attrs, { a: '1', b: '2', c: '3' });
  assert.equal(ps[1].attrs.a, 'quoted > gt');
});

test('xml: namespace prefixes are ignored when matching', () => {
  const doc = parseXML('<ns2:gpx><ns2:trk><name>x</name></ns2:trk></ns2:gpx>');
  assert.equal(findDescendants(doc, 'trk').length, 1);
});

test('xml: a stray closing tag does not detach the tree', () => {
  const doc = parseXML('<r><a>1</b><a>2</a></r>');
  assert.equal(findDescendants(doc, 'a').length, 2);
});

/* ------------------------------------------------------------------ GPX */

const SAMPLE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">
  <metadata><name>Trip</name><desc>A trip</desc><time>2024-05-01T09:00:00Z</time></metadata>
  <wpt lat="36.0" lon="-84.0"><ele>300</ele><name>Camp</name><sym>Campground</sym><cmt>Fallback text</cmt></wpt>
  <trk>
    <name>Day one</name>
    <extensions><gpxx:TrackExtension><gpxx:DisplayColor>DarkGreen</gpxx:DisplayColor></gpxx:TrackExtension></extensions>
    <trkseg>
      <trkpt lat="36.0" lon="-84.0"><ele>300</ele><time>2024-05-01T10:00:00Z</time></trkpt>
      <trkpt lat="36.1" lon="-84.0"><ele>400</ele><time>2024-05-01T11:00:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="36.2" lon="-84.0"><ele>380</ele></trkpt>
      <trkpt lat="36.3" lon="-84.0"><ele>360</ele></trkpt>
    </trkseg>
  </trk>
  <rte><name>Planned</name><rtept lat="36.0" lon="-84.5"/><rtept lat="36.1" lon="-84.5"/></rte>
</gpx>`;

test('gpx: extracts tracks, routes and waypoints with the right kinds', () => {
  const doc = parseGPX(SAMPLE_GPX);
  const kinds = doc.geojson.features.map((f) => f.properties.kind);
  assert.deepEqual(kinds, ['track', 'route', 'waypoint']);
  assert.equal(doc.name, 'Trip');
  assert.equal(doc.description, 'A trip');
});

test('gpx: multiple segments become a MultiLineString', () => {
  const track = parseGPX(SAMPLE_GPX).geojson.features[0];
  assert.equal(track.geometry.type, 'MultiLineString');
  assert.equal(track.geometry.coordinates.length, 2);
  assert.deepEqual(track.geometry.coordinates[0][0], [-84, 36, 300]);
});

test('gpx: Garmin DisplayColor names resolve to hex', () => {
  assert.equal(parseGPX(SAMPLE_GPX).geojson.features[0].properties.color, '#1f6f3d');
});

test('gpx: waypoint falls back from desc to cmt', () => {
  const waypoint = parseGPX(SAMPLE_GPX).geojson.features.find((f) => f.properties.kind === 'waypoint');
  assert.equal(waypoint.properties.description, 'Fallback text');
  assert.equal(waypoint.properties.symbol, 'Campground');
});

test('gpx: single-point segments are dropped rather than emitted as broken lines', () => {
  const doc = parseGPX('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>');
  assert.equal(doc.geojson.features.length, 0);
});

/* ------------------------------------------------------------------ KML */

const SAMPLE_KML = `<kml><Document><name>Byway</name>
  <Style id="s"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle>
    <PolyStyle><color>803d6f1f</color></PolyStyle></Style>
  <StyleMap id="m">
    <Pair><key>highlight</key><styleUrl>#s</styleUrl></Pair>
    <Pair><key>normal</key><styleUrl>#s</styleUrl></Pair>
  </StyleMap>
  <Folder><name>Day 1</name>
    <Placemark><name>Road</name><styleUrl>#m</styleUrl>
      <description><![CDATA[<p>Nice <b>drive</b></p>]]></description>
      <LineString><coordinates>-84.0,36.0,300
        -84.1,36.1,420</coordinates></LineString></Placemark>
    <Placemark><name>Clearing</name><styleUrl>#s</styleUrl><Polygon><outerBoundaryIs><LinearRing>
      <coordinates>-84.0,36.0 -84.0,36.1 -83.9,36.1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    <Placemark><name>Stop</name><ExtendedData><Data name="fee"><value>$5</value></Data></ExtendedData>
      <Point><coordinates>-84.05,36.05</coordinates></Point></Placemark>
  </Folder></Document></kml>`;

test('kml: aabbggrr colours convert to CSS hex', () => {
  const road = parseKML(SAMPLE_KML).geojson.features[0];
  assert.equal(road.properties.color, '#ff0000');
});

test('kml: StyleMap resolves through to the normal style', () => {
  assert.equal(parseKML(SAMPLE_KML).geojson.features[0].properties.width, 4);
});

test('kml: folder path is recorded and HTML descriptions are flattened', () => {
  const road = parseKML(SAMPLE_KML).geojson.features[0];
  assert.equal(road.properties.folder, 'Byway / Day 1');
  assert.equal(road.properties.description, 'Nice drive');
  assert.match(road.properties.descriptionHTML, /<b>drive<\/b>/);
});

test('kml: polygons are closed and classified as areas', () => {
  const clearing = parseKML(SAMPLE_KML).geojson.features.find((f) => f.properties.name === 'Clearing');
  assert.equal(clearing.geometry.type, 'Polygon');
  assert.equal(clearing.properties.kind, 'area');
  const ring = clearing.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test('kml: ExtendedData is preserved', () => {
  const stop = parseKML(SAMPLE_KML).geojson.features.find((f) => f.properties.name === 'Stop');
  assert.deepEqual(stop.properties.data, { fee: '$5' });
});

test('kml: gx:Track yields a line with matching timestamps', () => {
  const doc = parseKML(`<kml><Placemark><name>T</name><gx:Track>
    <when>2024-01-01T00:00:00Z</when><gx:coord>-84.0 36.0 300</gx:coord>
    <when>2024-01-01T01:00:00Z</when><gx:coord>-84.1 36.1 400</gx:coord>
  </gx:Track></Placemark></kml>`);
  const feature = doc.geojson.features[0];
  assert.equal(feature.geometry.type, 'LineString');
  assert.equal(feature.properties.coordTimes.length, 2);
});

test('kml: MultiGeometry of lines collapses to MultiLineString', () => {
  const doc = parseKML(`<kml><Placemark><MultiGeometry>
    <LineString><coordinates>0,0 1,1</coordinates></LineString>
    <LineString><coordinates>2,2 3,3</coordinates></LineString>
  </MultiGeometry></Placemark></kml>`);
  assert.equal(doc.geojson.features[0].geometry.type, 'MultiLineString');
});

/* ------------------------------------------------------------------ geometry */

test('geo: haversine matches a known one-degree meridian span', () => {
  const metres = haversine([-84, 36], [-84, 37]);
  assert.ok(Math.abs(metres - 111195) < 200, `got ${metres}`);
});

test('geo: line length sums its segments', () => {
  const line = [[-84, 36], [-84, 36.1], [-84, 36.2]];
  assert.ok(Math.abs(lineLength(line) - 2 * haversine([-84, 36], [-84, 36.1])) < 1e-6);
});

test('geo: elevation hysteresis rejects sub-threshold GPS noise', () => {
  const noisy = Array.from({ length: 200 }, (_, i) => [-84, 36 + i * 1e-4, 300 + (i % 2 ? 1 : -1)]);
  const { ascent } = elevationChange(noisy, 3);
  assert.ok(ascent < 5, `noise banked ${ascent} m of gain`);
});

test('geo: elevation hysteresis keeps a real climb', () => {
  const climb = Array.from({ length: 100 }, (_, i) => [-84, 36 + i * 1e-4, 300 + i * 5]);
  const { ascent, descent } = elevationChange(climb, 3);
  assert.ok(Math.abs(ascent - 495) < 1, `got ${ascent}`);
  assert.equal(descent, 0);
});

test('geo: simplify keeps the endpoints and drops collinear points', () => {
  const line = Array.from({ length: 50 }, (_, i) => [-84 + i * 1e-4, 36]);
  const reduced = simplify(line, 1e-5);
  assert.equal(reduced.length, 2);
  assert.deepEqual(reduced[0], line[0]);
  assert.deepEqual(reduced[1], line[line.length - 1]);
});

test('geo: bounds validity and merging', () => {
  assert.equal(boundsAreValid([Infinity, Infinity, -Infinity, -Infinity]), false);
  assert.deepEqual(mergeBounds([0, 0, 1, 1], [-1, -1, 0.5, 0.5]), [-1, -1, 1, 1]);
});

test('geo: formatting switches units and degrades gracefully', () => {
  assert.equal(formatDistance(1609.344), '1.0 mi');
  assert.equal(formatDistance(1000, 'metric'), '1.0 km');
  assert.equal(formatElevation(304.8), '1,000 ft');
  assert.equal(formatDuration(3660), '1h 01m');
  assert.equal(formatDistance(NaN), '—');
});

/* ------------------------------------------------------------------ pipeline */

test('parse: dispatches by extension and computes summary statistics', async () => {
  const doc = await parseMapFile(SAMPLE_GPX, 'trip.gpx');
  assert.equal(doc.format, 'gpx');
  assert.equal(doc.stats.trackCount, 1);
  assert.equal(doc.stats.routeCount, 1);
  assert.equal(doc.stats.waypointCount, 1);
  assert.ok(doc.stats.distance_m > 20000);
  assert.equal(doc.stats.duration_s, 3600);
  assert.ok(boundsAreValid(doc.bbox));
});

test('parse: sniffs the format when the extension is unhelpful', async () => {
  assert.equal((await parseMapFile(SAMPLE_GPX, 'export.txt')).format, 'gpx');
  assert.equal((await parseMapFile(SAMPLE_KML, 'export.dat')).format, 'kml');
});

test('parse: accepts plain GeoJSON and assigns feature kinds', async () => {
  const doc = await parseMapFile(JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-84, 36] }, properties: { name: 'P' } }],
  }), 'x.geojson');
  assert.equal(doc.geojson.features[0].properties.kind, 'waypoint');
});

test('parse: rejects content it cannot recognise', async () => {
  await assert.rejects(() => parseMapFile('not a map at all', 'x.txt'), /Unrecognised map file/);
});

test('summarize: per-feature measurements are written back onto properties', () => {
  const collection = parseGPX(SAMPLE_GPX).geojson;
  summarize(collection);
  const track = collection.features[0];
  assert.ok(track.properties.distance_m > 0);
  assert.equal(track.properties.elevation_max_m, 400);
});

/* ------------------------------------------------------------------ KMZ */

/** Build a zip with one STORED (uncompressed) entry — enough to test the reader. */
function makeStoredZip(name, contents) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const dataBytes = encoder.encode(contents);
  const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, 0, true);            // stored
  localView.setUint32(18, dataBytes.length, true);
  localView.setUint32(22, dataBytes.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(dataBytes, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint32(20, dataBytes.length, true);
  centralView.setUint32(24, dataBytes.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);         // local header offset
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.length, true);
  eocdView.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out.buffer;
}

test('kmz: reads the KML entry out of a zip container', async () => {
  const buffer = makeStoredZip('doc.kml', SAMPLE_KML);
  const text = await extractKMLFromKMZ(buffer);
  assert.match(text, /<kml>/);
  const doc = await parseMapFile(buffer, 'trip.kmz');
  assert.equal(doc.format, 'kml');
  assert.ok(doc.geojson.features.length >= 3);
});

test('kmz: a zip with no KML entry reports a useful error', async () => {
  await assert.rejects(
    () => extractKMLFromKMZ(makeStoredZip('readme.txt', 'hello')),
    /No .kml document/,
  );
});

/*
 * A GaiaGPS GeoJSON export, as it actually arrives.
 *
 * The name came across and nothing else did: notes, colour and symbol sat in
 * the file under Gaia's own names and the pins landed as plain dots. Every
 * field a person filled in over there has to be the field this app reads.
 */
test('geojson: a GaiaGPS export keeps its title, notes, colour and symbol', async () => {
  const gaia = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-81.05, 37.02] },
      // The property names as a 2026 Gaia export actually writes them.
      properties: {
        title: 'Big Walker Lookout',
        notes: 'Cab not accessible.',
        icon: 'fire-lookout',
        marker_type: 'outlined-icon',
        marker_color: '#2D3FC7',
        marker_decoration: 'fire-lookout',
        elevation: 599,
        time_created: '2026-02-17T15:58:49Z',
        photos: [{ id: 'p1', web_url: 'https://www.gaiagps.com/api/objects/photo/p1/image/375/', fullsize_url: 'https://www.gaiagps.com/api/objects/photo/p1/image/full/' }],
      },
    }, {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-81.1, 37.1] },
      // The simplestyle spelling, which GitHub and Mapbox render.
      properties: { title: 'Camp', description: 'Gate locked at dusk', 'marker-symbol': 'campsite', 'marker-color': '2E5C9A' },
    }],
  };
  const doc = await parseMapFile(JSON.stringify(gaia), 'gaia.geojson');
  const [lookout, camp] = doc.geojson.features.map((f) => f.properties);

  assert.equal(lookout.name, 'Big Walker Lookout');
  assert.equal(lookout.description, 'Cab not accessible.');
  assert.equal(lookout.color, '#2D3FC7', 'Gaia spells it marker_color');
  assert.equal(lookout.icon, 'tower', 'Gaia\'s icon name resolves like a GPX <sym>');
  assert.equal(lookout.link, 'https://www.gaiagps.com/api/objects/photo/p1/image/full/', 'the photo is the link');
  assert.equal(lookout.time, Date.parse('2026-02-17T15:58:49Z'));
  assert.deepEqual(doc.geojson.features[0].geometry.coordinates, [-81.05, 37.02, 599], 'elevation moves into the coordinate');

  assert.equal(camp.description, 'Gate locked at dusk');
  assert.equal(camp.color, '#2E5C9A', 'a bare hex is still a colour');
  assert.equal(camp.icon, 'tent');
});

test('geojson: a pin id this app already knows is left exactly alone', async () => {
  const doc = await parseMapFile(JSON.stringify({
    type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { name: 'Ours', icon: 'tower', color: '#000000', description: 'kept' },
  }), 'ours.geojson');
  const props = doc.geojson.features[0].properties;
  assert.equal(props.icon, 'tower');
  assert.equal(props.symbol, undefined);
  assert.equal(props.description, 'kept');
});

/*
 * A symbol name is matched by the alias that explains most of it. "Fire
 * lookout" went to the campfire because "fire" came first in the table; the
 * word that covers more of what was typed is the one that was meant.
 */
test('symbols: the longest matching alias wins, not the first in the table', () => {
  assert.equal(iconForSymbol('fire lookout'), 'tower');
  assert.equal(iconForSymbol('Fire Tower'), 'tower');
  assert.equal(iconForSymbol('campfire'), 'campfire');
  assert.equal(iconForSymbol('Flag, Blue'), iconForSymbol('flag'));
  assert.equal(iconForSymbol(''), null);
});

/*
 * Addresses inside prose somebody typed in the field. The grammar is narrow
 * on purpose: a false positive turns a note into a broken link, and the
 * punctuation that ends a sentence is not part of the address.
 */
test('links: a web address is found inside a note, without the punctuation around it', () => {
  assert.deepEqual(findLinks('Write-up at https://example.org/tower, worth a read.'),
    ['https://example.org/tower']);
  assert.deepEqual(findLinks('see https://example.org/x.'), ['https://example.org/x']);
  assert.deepEqual(findLinks('(https://a.example/c) and http://d.example/e'),
    ['https://a.example/c', 'http://d.example/e']);
  // A bare host is an address people write; it is given a scheme so it opens.
  assert.deepEqual(findLinks('go to www.nps.gov/abc, then left'), ['https://www.nps.gov/abc']);

  assert.deepEqual(findLinks('Gate is locked. Park at the pull-off.'), []);
  assert.deepEqual(findLinks('https://'), [], 'a scheme on its own is not an address');
  assert.deepEqual(findLinks('www.'), []);
  assert.equal(findLink(''), null);
  assert.equal(findLink(null), null);
});

/*
 * A note is shown as it was typed, with the addresses in it made tappable in
 * place - so the span has to say both what was written and where it starts.
 * A scheme the writer did not type is not one the reader should be shown.
 */
test('links: a span says what was written, where, and what to follow', () => {
  assert.deepEqual(findLinkSpans('go to www.nps.gov/abc, then left'),
    [{ text: 'www.nps.gov/abc', href: 'https://www.nps.gov/abc', at: 6 }]);
  assert.deepEqual(findLinkSpans('see https://www.nps.gov/x here'),
    [{ text: 'https://www.nps.gov/x', href: 'https://www.nps.gov/x', at: 4 }]);
});

/*
 * GPX puts the wording for a link in <link><text>, and the older files put it
 * in <urlname>. It is the writer's own name for where the link goes, which
 * serves a reader better than a label the app invented.
 */
test('gpx: a waypoint link keeps the wording the file gave it', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1">
    <wpt lat="37" lon="-84"><name>Tower</name>
      <link href="https://example.org/tower"><text>Fire tower history</text></link>
    </wpt>
    <wpt lat="38" lon="-85"><name>Ford</name>
      <url>https://example.org/ford</url><urlname>Crossing notes</urlname>
    </wpt>
    <wpt lat="39" lon="-86"><name>Gap</name>
      <link href="https://example.org/gap"/>
    </wpt>
  </gpx>`;
  const props = parseGPX(gpx).geojson.features.map((feature) => feature.properties);
  assert.equal(props[0].link, 'https://example.org/tower');
  assert.equal(props[0].linkLabel, 'Fire tower history');
  assert.equal(props[1].link, 'https://example.org/ford');
  assert.equal(props[1].linkLabel, 'Crossing notes');
  assert.equal(props[2].link, 'https://example.org/gap');
  assert.equal(props[2].linkLabel, null, 'no wording is no wording, not a guess');
});

/*
 * An address typed into a note becomes the pin's link and leaves the note.
 *
 * The note is for what the place is like; a bare address in the middle of one
 * is neither read nor tapped comfortably. What is left behind is tidied, or
 * there is nothing left and the note is empty.
 */
test('import: a web address in a note moves into the link field', async () => {
  // Through parseMapFile, which is the import path: the promotion runs for
  // every format rather than only for the one that happens to be tested.
  const gpx = (desc) => `<?xml version="1.0"?><gpx version="1.1">
    <wpt lat="37" lon="-84"><name>Tower</name><desc>${desc}</desc></wpt>
  </gpx>`;
  const one = async (desc) => (await parseMapFile(gpx(desc), 'notes.gpx')).geojson.features[0].properties;

  let props = await one('Write-up at https://example.org/tower, worth a read.');
  assert.equal(props.link, 'https://example.org/tower');
  assert.equal(props.description, 'Write-up, worth a read.', 'the dangling preposition goes too');

  props = await one('https://example.org/only');
  assert.equal(props.link, 'https://example.org/only');
  assert.equal(props.description, '', 'a note that was only an address is empty, not punctuation');

  props = await one('Gate locked. See www.nps.gov/abc');
  assert.equal(props.link, 'https://www.nps.gov/abc', 'a bare host is given a scheme to be followed');
  assert.equal(props.description, 'Gate locked.');

  // Only the first goes: a note listing sources is a note about sources.
  props = await one('Two: https://a.example/1 and https://b.example/2');
  assert.equal(props.link, 'https://a.example/1');
  assert.match(props.description, /https:\/\/b\.example\/2/);

  props = await one('Gate is unlocked.');
  assert.equal(props.link, null);
  assert.equal(props.description, 'Gate is unlocked.', 'a note with no address is untouched');
});

/*
 * A <link> of its own beats one buried in the prose, and the prose keeps
 * whatever it says - there was nothing to move.
 */
test('import: a link field of its own leaves the note alone', async () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1">
    <wpt lat="37" lon="-84"><name>Tower</name>
      <desc>Also see https://example.org/other</desc>
      <link href="https://example.org/official"><text>NPS page</text></link>
    </wpt>
  </gpx>`;
  const props = (await parseMapFile(gpx, 'linked.gpx')).geojson.features[0].properties;
  assert.equal(props.link, 'https://example.org/official');
  assert.equal(props.linkLabel, 'NPS page');
  assert.equal(props.description, 'Also see https://example.org/other');
});
