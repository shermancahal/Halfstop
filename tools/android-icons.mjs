/**
 * The Halfstop mark, as the Android project needs it.
 *
 * `cap add android` fills res/ with Capacitor's own logo - the launcher icon,
 * the adaptive icon's layers and a splash screen - and android/ is gitignored
 * and regenerated, so anything put there by hand is gone the next time it is
 * made. This renders the Android set from assets/img/mark-master.png, the same
 * master every website icon comes from, and tools/app.mjs writes it into res/
 * on every build. No @capacitor/assets, which would bring an image library as
 * a dependency for what the repository's own rasteriser already does.
 *
 * THREE THINGS ANDROID DRAWS, AND WHICH IS WHICH
 *
 *   The adaptive icon (Android 8 and later - nearly every phone). Two layers:
 *   a flat colour behind, and the medallion alone in front, on transparency.
 *   The launcher masks the pair to its own shape and may move the front layer
 *   a little, so the medallion has to sit inside the middle 66dp of 108dp,
 *   the part Android promises never to cut.
 *
 *   The legacy icons (Android 7), square and round. Drawn as they are, so the
 *   square one is the full artwork and the round one is it cut to a circle.
 *
 *   The splash. Android 12 and later draws its own from the adaptive icon on
 *   `windowSplashScreenBackground`; before that, and briefly after it on every
 *   version, the launch window shows @drawable/splash. Capacitor ships that as
 *   eleven stretched PNGs - which is its logo on white, and would be ours
 *   stretched into an oval on any phone not shaped 2:3. It is a layer list
 *   here instead: the colour, and the medallion centred at its own size.
 */

import { resizeRGBA, cropRGBA, encodePNG } from './raster.mjs';
import { renderIcon, medallionExtent, TIGHT } from './build-app-icons.mjs';

/**
 * The colour behind the medallion.
 *
 * The site's `--chrome`, which is also the splash colour in
 * capacitor.config.json and, measured, the artwork's own ground: its mean is
 * #1e2544, one step away. So the icon's ground, the splash and the header the
 * app opens onto are one colour.
 */
export const GROUND = '#1f2846';

/** Android's densities, and how many pixels one dp is at each. */
export const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/** Legacy launcher icons are 48dp; an adaptive layer is 108dp. */
const LEGACY_DP = 48;
const LAYER_DP = 108;

/**
 * How much of the 108dp layer the medallion spans.
 *
 * Android guarantees the middle 66dp - 61% - survives every mask. 58% keeps
 * the bezel inside that with room for rounding and the soft edge, so a
 * circular launcher shows the whole ring rather than an arc of it. 60% was
 * tried first and reached 61.6% at the smallest density: the soft edge is a
 * pixel, and at 108px a pixel is a percent.
 */
export const LAYER_FILL = 0.58;

/**
 * The medallion on the splash, in dp.
 *
 * Android 12's own splash shows the adaptive icon in a 160dp circle, where the
 * medallion comes out at about 144dp. The launch window's drawable uses the
 * same size, so the hand-over from one to the other is not a jump.
 */
export const SPLASH_MARK_DP = 144;

/**
 * The medallion alone, with transparent corners, sized so the medallion - not
 * the frame around it - spans `diameter` pixels.
 *
 * The "tight" crop keeps a sliver of margin round the medallion, and how much
 * is measured from the master rather than assumed, as build-app-icons does.
 */
function medallion(master, diameter) {
  const extent = medallionExtent(master);
  const share = extent ? (2 * extent.radius) / (master.width * TIGHT) : 1;
  return renderIcon(master, { size: Math.max(1, Math.round(diameter / share)), shape: 'tight' });
}

/** An image centred on a transparent square canvas. */
function centred(image, size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const offset = Math.round((size - image.width) / 2);
  for (let y = 0; y < image.height; y += 1) {
    const ty = y + offset;
    if (ty < 0 || ty >= size) continue;
    for (let x = 0; x < image.width; x += 1) {
      const tx = x + offset;
      if (tx < 0 || tx >= size) continue;
      const from = (y * image.width + x) * 4;
      const to = (ty * size + tx) * 4;
      rgba[to] = image.rgba[from]; rgba[to + 1] = image.rgba[from + 1];
      rgba[to + 2] = image.rgba[from + 2]; rgba[to + 3] = image.rgba[from + 3];
    }
  }
  return { width: size, height: size, rgba };
}

/** The image cut to the circle that fits it, with a one-pixel soft edge. */
function roundOff({ width, height, rgba }) {
  const out = Uint8ClampedArray.from(rgba);
  const r = width / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const keep = Math.max(0, Math.min(1, r - d + 0.5));
      out[(y * width + x) * 4 + 3] = Math.round(rgba[(y * width + x) * 4 + 3] * keep);
    }
  }
  return { width, height, rgba: out };
}

const XML_ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;

/*
 * The launch window's background: the ground colour, and the medallion at its
 * own size in the middle. A <bitmap> with gravity is drawn unscaled, which is
 * the whole reason for this file - the PNGs it replaces were stretched to the
 * window.
 */
const XML_SPLASH = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/ic_launcher_background"/>
    <item>
        <bitmap android:gravity="center" android:src="@drawable/splash_mark"/>
    </item>
</layer-list>
`;

/**
 * Every file to write, as res/-relative path → contents.
 *
 * Pure over the master, so a test can check sizes, transparency and the XML
 * without an Android project anywhere near it.
 */
export function androidResources(master, { ground = GROUND } = {}) {
  const files = new Map();

  for (const [bucket, scale] of Object.entries(DENSITIES)) {
    const legacy = Math.round(LEGACY_DP * scale);
    const square = renderIcon(master, { size: legacy, shape: 'bleed' });
    files.set(`mipmap-${bucket}/ic_launcher.png`, encodePNG(legacy, legacy, square.rgba));
    const round = roundOff(square);
    files.set(`mipmap-${bucket}/ic_launcher_round.png`, encodePNG(legacy, legacy, round.rgba));

    const layer = Math.round(LAYER_DP * scale);
    const front = centred(medallion(master, Math.round(layer * LAYER_FILL)), layer);
    files.set(`mipmap-${bucket}/ic_launcher_foreground.png`, encodePNG(layer, layer, front.rgba));

    const mark = medallion(master, Math.round(SPLASH_MARK_DP * scale));
    files.set(`drawable-${bucket}/splash_mark.png`, encodePNG(mark.width, mark.height, mark.rgba));
  }

  files.set('mipmap-anydpi-v26/ic_launcher.xml', XML_ADAPTIVE);
  files.set('mipmap-anydpi-v26/ic_launcher_round.xml', XML_ADAPTIVE);
  files.set('values/ic_launcher_background.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${ground.toUpperCase()}</color>
</resources>
`);
  files.set('drawable/splash.xml', XML_SPLASH);
  return files;
}

/**
 * Capacitor's splash PNGs, which have to go.
 *
 * Android picks a resource by the most specific folder that has one, so a
 * drawable-port-xxhdpi/splash.png left in place would beat drawable/splash.xml
 * on exactly the phones it matters on, and a drawable/splash.png beside the
 * .xml is a build error: two files for one resource name.
 */
export const REPLACED = [
  'drawable/splash.png',
  ...['land', 'port'].flatMap((orientation) => Object.keys(DENSITIES)
    .map((bucket) => `drawable-${orientation}-${bucket}/splash.png`)),
];

/**
 * The launch theme with the splash background named, so Android 12's own
 * splash is the ground colour rather than white.
 *
 * `windowSplashScreenBackground` is core-splashscreen's attribute, which
 * Capacitor's template already depends on. Added to the one style that
 * inherits Theme.SplashScreen and nowhere else; left alone if it is there.
 */
export function withSplashBackground(stylesXml) {
  const text = String(stylesXml || '');
  if (text.includes('windowSplashScreenBackground')) return { text, changed: false };
  const launch = /(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)/;
  if (!launch.test(text)) return { text, changed: false };
  const fixed = text.replace(launch,
    '$1\n        <item name="windowSplashScreenBackground">@color/ic_launcher_background</item>');
  return { text: fixed, changed: true };
}

// Exported for the tests, which check what a launcher will actually show.
export const internals = { medallion, centred, roundOff, cropRGBA, resizeRGBA };
