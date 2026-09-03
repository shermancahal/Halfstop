import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PIN_ICONS, PIN_INK, iconForSymbol, pinColorFor, getPinIcon, DEFAULT_PIN_ICON,
  searchPinIcons, pinIconGroups, GLYPH, pinIconSVG,
} from '../assets/js/lib/pin-icons.js';

/*
 * The pin set is data other data depends on: ids are stored in saved folders
 * and aliases are how a GaiaGPS or Garmin symbol name lands on a picture.
 * A duplicate id would draw the wrong glyph for somebody's saved pins; an
 * alias shared by two icons would send the same word two places depending on
 * table order.
 */
test('pins: every id is unique and every icon can be drawn', () => {
  const ids = PIN_ICONS.map((icon) => icon.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate icon id');
  for (const icon of PIN_ICONS) {
    assert.ok(icon.name && icon.group, `${icon.id} needs a name and a group`);
    assert.ok((icon.d?.length || 0) + (icon.f?.length || 0) > 0, `${icon.id} has no paths`);
  }
});

test('pins: no two icons claim the same symbol name', () => {
  const owner = new Map();
  for (const icon of PIN_ICONS) {
    for (const alias of icon.sym || []) {
      const key = alias.toLowerCase();
      assert.ok(!owner.has(key) || owner.get(key) === icon.id,
        `"${alias}" is claimed by both ${owner.get(key)} and ${icon.id}`);
      owner.set(key, icon.id);
    }
  }
});

/*
 * The names GaiaGPS actually writes, from five real exports, and the ones a
 * person would type. Each has to land on the picture it means.
 */
test('pins: the names Gaia and people use land on the right picture', () => {
  const expect = {
    'fire-lookout': 'tower', 'Fire Tower': 'tower', 'lookout tower': 'tower',
    bridge: 'bridge', 'covered bridge': 'covered-bridge', 'covered-bridge': 'covered-bridge',
    'ghost-town': 'ruins', 'Ghost Town': 'ruins', abandoned: 'abandoned',
    hospital: 'hospital', house: 'house', factory: 'industry', industry: 'industry',
    military: 'military', school: 'school', church: 'church', cemetery: 'cemetery',
    lighthouse: 'lighthouse', canal: 'canal', lock: 'canal', dam: 'dam',
    railroad: 'railroad', train: 'railroad', road: 'road', tunnel: 'tunnel',
    waterfall: 'waterfall', falls: 'waterfall', scenic: 'scenic', hiking: 'trailhead',
    water: 'water', campground: 'tent',
  };
  for (const [name, id] of Object.entries(expect)) {
    assert.equal(iconForSymbol(name), id, `"${name}" should be ${id}`);
  }
});

test('pins: an emoji Gaia wrote resolves, and an unknown one resolves to nothing', () => {
  assert.equal(iconForSymbol('emoji-\u{1F3ED}'), 'industry');
  assert.equal(iconForSymbol('emoji-\u{1F3ED}\u{FE0F}'), 'industry', 'a variation selector rides along');
  assert.equal(iconForSymbol('emoji-\u{1F984}'), null, 'a unicorn is not a place');
});

/*
 * The ring is the pin's own colour or ink. Never the symbol's, never the
 * folder's: people colour pins to mean things - visited, not yet - and a
 * colour the app chose would overwrite what they meant.
 */
test('pins: the ring is the pin\'s own colour, else ink', () => {
  assert.equal(pinColorFor({ icon: 'tower' }), PIN_INK);
  assert.equal(pinColorFor({ icon: 'tower', color: '#2D3FC7' }), '#2D3FC7', 'an imported colour stands');
  assert.equal(pinColorFor({}), PIN_INK);
  assert.equal(pinColorFor(null), PIN_INK);
  assert.equal(getPinIcon('no-such-icon').id, DEFAULT_PIN_ICON);
});

/*
 * The park signs: every NPS symbol arrives as a pin of its own, prefixed so
 * it cannot shadow a drawn icon a saved pin already names, and marked with
 * the 22-unit grid it was drawn on so it is centred rather than cornered.
 */
test('pins: the park signs are in the picker, prefixed and on their grid', () => {
  const signs = PIN_ICONS.filter((icon) => icon.sign);
  assert.ok(signs.length >= 90, `${signs.length} park signs`);
  for (const icon of signs) {
    assert.match(icon.id, /^nps-[a-z0-9-]+$/);
    assert.equal(icon.grid, 22);
    assert.ok(icon.f.length > 0, `${icon.id} has no fills`);
  }
  for (const wanted of ['nps-lookout-tower', 'nps-waterfall', 'nps-chapel', 'nps-cannon', 'nps-rail-station', 'nps-tunnel', 'nps-lighthouse', 'nps-dam']) {
    assert.ok(signs.some((icon) => icon.id === wanted), `${wanted} missing`);
  }
});

/*
 * A hundred and seventy symbols in one flat list is a wall. Every sign lands
 * in one of the headings the drawn set already uses, and the ones that are
 * plainly a pastime are under Recreation rather than filed with the buildings.
 */
test('pins: park signs are filed under the same headings as the drawn set', () => {
  const groups = pinIconGroups();
  assert.ok(!groups.has('Park signs'), 'the flat list is gone');
  assert.ok(groups.has('Recreation'), 'there is somewhere for golf and skiing to live');

  const groupOf = (id) => PIN_ICONS.find((icon) => icon.id === id)?.group;
  assert.equal(groupOf('nps-golfing'), 'Recreation');
  assert.equal(groupOf('nps-downhill-skiing'), 'Recreation');
  assert.equal(groupOf('nps-waterfall'), 'Water', 'a waterfall is water, wherever the picture came from');
  assert.equal(groupOf('waterfall'), 'Water');
  assert.equal(groupOf('nps-rail-station'), 'Ways');

  // And nothing is left in a heading of its own by accident.
  for (const [name, icons] of groups) assert.ok(icons.length >= 3, `${name} holds only ${icons.length}`);
});

/*
 * The search has to answer the word somebody types, not the name we happened
 * to give a picture. "building" is the case that matters: nobody scrolls a
 * grid of a hundred and seventy looking for a courthouse.
 */
test('pins: searching finds symbols by the word a person would type', () => {
  const ids = (query) => searchPinIcons(query).map((icon) => icon.id);

  const buildings = ids('building');
  for (const wanted of ['house', 'church', 'school', 'hospital', 'industry', 'abandoned-building']) {
    assert.ok(buildings.includes(wanted), `"building" should find ${wanted}`);
  }
  assert.ok(ids('abandoned').includes('ruins'), 'a ghost town is abandoned');
  assert.deepEqual(ids('covered bridge'), ['covered-bridge'], 'both words have to match');
  assert.ok(ids('fire lookout').includes('tower'));
  assert.ok(ids('golf').includes('nps-golfing'));
  assert.deepEqual(ids('xyzzy'), []);
  assert.deepEqual(searchPinIcons(''), [], 'an empty query is not a match-everything');
});

/*
 * Substring matching made "rail" find every ski *trail*, which is how a
 * reader learns the search does not work. A term matches a word it starts.
 */
test('pins: a search term matches a word it starts, not any substring', () => {
  const rail = searchPinIcons('rail').map((icon) => icon.id);
  assert.ok(rail.includes('railroad'));
  assert.ok(!rail.includes('nps-cross-country-ski-trail'), 'rail is not trail');
  assert.ok(searchPinIcons('trail').map((icon) => icon.id).includes('trailhead'));
});

test('pins: the abandoned building is its own symbol, not the shut shop', () => {
  const building = PIN_ICONS.find((icon) => icon.id === 'abandoned-building');
  const shop = PIN_ICONS.find((icon) => icon.id === 'abandoned');
  assert.ok(building && shop);
  assert.notDeepEqual(building.d, shop.d, 'two ideas, two drawings');
  assert.equal(iconForSymbol('Abandoned Building'), 'abandoned-building');
  assert.equal(iconForSymbol('abandoned'), 'abandoned');
});

/*
 * Colour, where colour is the thing being identified.
 *
 * A path may carry its own; most do not, and the ones that do must draw with
 * it in both places a glyph is drawn - the inline SVG in the panel and the
 * canvas that becomes a map image. A colour off the short list is a slip.
 */
test('pins: a coloured path draws in its colour, and the rest stay ink', () => {
  const palette = new Set(Object.values(GLYPH));
  let coloured = 0;
  for (const icon of PIN_ICONS) {
    for (const entry of [...(icon.d || []), ...(icon.f || [])]) {
      if (!Array.isArray(entry)) continue;
      coloured += 1;
      assert.equal(entry.length, 2, `${icon.id}: a coloured path is [path, colour]`);
      assert.ok(palette.has(entry[1]), `${icon.id}: ${entry[1]} is not one of the glyph colours`);
    }
  }
  assert.ok(coloured >= 20, `only ${coloured} coloured paths`);

  const fire = pinIconSVG('campfire');
  assert.ok(fire.includes(`stroke="${GLYPH.flame}"`), 'the flame is drawn in flame');
  assert.ok(fire.includes(`stroke="${GLYPH.wood}"`), 'the logs are drawn in wood');
  // An uncoloured glyph is untouched: no stroke attribute at all, so it
  // inherits whatever the surrounding text colour is.
  assert.ok(!pinIconSVG('house').includes('stroke="#'), 'an ink glyph names no colour');
});
