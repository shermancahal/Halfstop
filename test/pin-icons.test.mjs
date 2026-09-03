import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PIN_ICONS, PIN_FAMILY, iconForSymbol, pinColorFor, getPinIcon, DEFAULT_PIN_ICON,
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
 * The colour is the family's, so a map of mixed folders still reads: brown is
 * built, blue is water, slate is engineering. A pin's own colour beats it; the
 * folder's is the last resort, for a plain pin.
 */
test('pins: a symbol wears its family colour unless the pin says otherwise', () => {
  assert.equal(pinColorFor({ icon: 'tower' }, '#folder'), PIN_FAMILY.built);
  assert.equal(pinColorFor({ icon: 'canal' }, '#folder'), PIN_FAMILY.water);
  assert.equal(pinColorFor({ icon: 'tower', color: '#123456' }, '#folder'), '#123456');
  assert.equal(pinColorFor({ icon: DEFAULT_PIN_ICON }, '#folder'), '#folder', 'a plain pin has no family');
  assert.equal(pinColorFor({}, '#folder'), '#folder');
  assert.equal(pinColorFor(null, '#folder'), '#folder');
});

test('pins: every family colour on an icon is one of the named families', () => {
  const families = new Set(Object.values(PIN_FAMILY));
  for (const icon of PIN_ICONS) {
    if (icon.color) assert.ok(families.has(icon.color), `${icon.id} has an off-family colour`);
  }
  assert.equal(getPinIcon('no-such-icon').id, DEFAULT_PIN_ICON);
});
