/**
 * The Halfstop mark in the Android project, instead of Capacitor's.
 *
 * What a mistake here looks like is a launcher: the bezel cut into an arc by a
 * circular mask, a medallion on a white square, the Capacitor logo on the
 * splash of an older phone, or a splash stretched into an oval. None of those
 * fail a build. These check the pixels and the files that decide them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  androidResources, DENSITIES, GROUND, LAYER_FILL, REPLACED, SPLASH_MARK_DP, withSplashBackground,
} from '../tools/android-icons.mjs';
import { readMaster } from '../tools/build-app-icons.mjs';
import { decodePNG } from '../tools/raster.mjs';
import { writeAndroidIcons } from '../tools/app.mjs';

const master = await readMaster();
const files = androidResources(master);
const png = (name) => decodePNG(files.get(name));
const alphaAt = (image, x, y) => image.rgba[(y * image.width + x) * 4 + 3];

/** How far from the centre anything visible reaches, as a share of the width. */
function reach(image) {
  const c = image.width / 2;
  let far = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(image, x, y) < 16) continue;
      far = Math.max(far, Math.hypot(x + 0.5 - c, y + 0.5 - c));
    }
  }
  return (2 * far) / image.width;
}

test('android icons: every density gets a launcher icon, a round one, a front layer and a splash mark', () => {
  for (const [bucket, scale] of Object.entries(DENSITIES)) {
    assert.equal(png(`mipmap-${bucket}/ic_launcher.png`).width, Math.round(48 * scale));
    assert.equal(png(`mipmap-${bucket}/ic_launcher_round.png`).width, Math.round(48 * scale));
    assert.equal(png(`mipmap-${bucket}/ic_launcher_foreground.png`).width, Math.round(108 * scale));
    assert.ok(files.has(`drawable-${bucket}/splash_mark.png`), bucket);
  }
});

test('android icons: the front layer stays inside the part no launcher mask cuts', () => {
  // Android promises the middle 66dp of 108dp. Past it, a circular launcher
  // cuts the bezel into an arc.
  for (const bucket of Object.keys(DENSITIES)) {
    const front = png(`mipmap-${bucket}/ic_launcher_foreground.png`);
    const spans = reach(front);
    assert.ok(spans <= 66 / 108, `${bucket}: the medallion reaches ${(spans * 100).toFixed(1)}% of the layer`);
    // And is not lost in the middle of it either.
    assert.ok(spans >= LAYER_FILL - 0.05, `${bucket}: the medallion only reaches ${(spans * 100).toFixed(1)}%`);
    // Transparent around it, so the background colour is what shows there.
    assert.equal(alphaAt(front, 0, 0), 0);
    assert.equal(alphaAt(front, front.width - 1, front.height - 1), 0);
  }
});

test('android icons: the square icon is opaque to the corner, the round one is not', () => {
  const square = png('mipmap-xxxhdpi/ic_launcher.png');
  const round = png('mipmap-xxxhdpi/ic_launcher_round.png');
  assert.equal(alphaAt(square, 0, 0), 255);
  assert.equal(alphaAt(round, 0, 0), 0);
  assert.equal(alphaAt(round, round.width / 2, round.height / 2), 255);
});

test('android icons: the splash mark is the medallion at the size Android 12 draws it', () => {
  for (const [bucket, scale] of Object.entries(DENSITIES)) {
    const mark = png(`drawable-${bucket}/splash_mark.png`);
    const across = reach(mark) * mark.width;
    assert.ok(Math.abs(across - SPLASH_MARK_DP * scale) <= 3 * scale,
      `${bucket}: the medallion is ${across.toFixed(0)}px across, not ${SPLASH_MARK_DP * scale}`);
  }
});

test('android icons: one ground colour behind the icon and the splash, and it is the header\'s', async () => {
  const { readFile } = await import('node:fs/promises');
  assert.match(files.get('values/ic_launcher_background.xml'), new RegExp(`>${GROUND}<`, 'i'));
  const css = await readFile(new URL('../assets/css/site.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`--chrome:\\s*${GROUND};`, 'i'));
  const config = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(config.plugins.SplashScreen.backgroundColor.toLowerCase(), GROUND.toLowerCase());
});

test('android icons: the adaptive icon names the layers that are written', () => {
  for (const name of ['mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v26/ic_launcher_round.xml']) {
    assert.match(files.get(name), /@color\/ic_launcher_background/);
    assert.match(files.get(name), /@mipmap\/ic_launcher_foreground/);
  }
  // The splash draws the mark unscaled in the middle, rather than stretching
  // an image to the window.
  assert.match(files.get('drawable/splash.xml'), /<bitmap android:gravity="center" android:src="@drawable\/splash_mark"\/>/);
});

const STYLES = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
    </style>


    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>`;

test('android icons: Android 12\'s own splash is the ground colour, not white', () => {
  const { text, changed } = withSplashBackground(STYLES);
  assert.equal(changed, true);
  assert.match(text, /NoActionBarLaunch" parent="Theme.SplashScreen">\n\s*<item name="windowSplashScreenBackground">@color\/ic_launcher_background<\/item>/);
  // Only the launch theme: the app's own theme must not grow a splash.
  assert.equal(text.match(/windowSplashScreenBackground/g).length, 1);
  assert.deepEqual(withSplashBackground(text), { text, changed: false });
});

test('android icons: written into a Capacitor res/ folder, Capacitor\'s splash images go', async () => {
  // Left in place, drawable-port-xxhdpi/splash.png beats drawable/splash.xml on
  // the phones it matters on, and drawable/splash.png beside it will not build.
  const res = mkdtempSync(path.join(tmpdir(), 'halfstop-res-'));
  try {
    for (const relative of [...REPLACED, 'mipmap-xxhdpi/ic_launcher.png', 'drawable-v24/ic_launcher_foreground.xml']) {
      mkdirSync(path.dirname(path.join(res, relative)), { recursive: true });
      writeFileSync(path.join(res, relative), 'capacitor');
    }
    mkdirSync(path.join(res, 'values'), { recursive: true });
    writeFileSync(path.join(res, 'values', 'styles.xml'), STYLES);

    const first = await writeAndroidIcons(res, { master });
    assert.equal(first.removed, REPLACED.length);
    for (const relative of REPLACED) assert.equal(existsSync(path.join(res, relative)), false, relative);
    for (const relative of files.keys()) assert.ok(existsSync(path.join(res, relative)), relative);
    assert.notEqual(readFileSync(path.join(res, 'mipmap-xxhdpi/ic_launcher.png'), 'utf8'), 'capacitor');
    assert.match(readFileSync(path.join(res, 'values', 'styles.xml'), 'utf8'), /windowSplashScreenBackground/);
    // Capacitor's vector layers are not ours to remove: nothing refers to them.
    assert.ok(existsSync(path.join(res, 'drawable-v24/ic_launcher_foreground.xml')));

    // It runs on every build, so the second run is the common one.
    assert.deepEqual(await writeAndroidIcons(res, { master }), { written: 0, removed: 0 });
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
});
