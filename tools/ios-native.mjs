/**
 * What the iPhone project needs that `npx cap add ios` does not write.
 *
 * The iOS twin of the Android edits in tools/app.mjs, and for the same reason:
 * ios/ is gitignored and regenerated, so anything typed into Xcode or
 * Info.plist by hand is gone the next time somebody starts from a clean
 * checkout - silently, because the build still succeeds. docs/app-auth.md
 * said as much ("this must be scripted, not typed into Xcode") and named this
 * file before it existed.
 *
 * Four things, every run:
 *
 *   - The URL scheme, so an emailed sign-in link and the return from Google
 *     open the app rather than Safari. The page side of that is
 *     assets/js/lib/native-shell.js, shared with Android.
 *   - The usage strings iOS requires before it will ask for a permission.
 *     Location, for the map. The camera, because the waypoint photo picker
 *     offers Take Photo, and an app that opens the camera without declaring
 *     why is closed on the spot rather than refused politely. And adding to
 *     the photo library, for the map snapshot.
 *   - The icon and the launch image, from the same master as everything else.
 *   - The version, so App Store Connect accepts each build.
 *
 * Plain text edits rather than a plist library: the project has no
 * dependencies and these are four well-known keys in a file whose shape
 * Capacitor fixes. Each edit adds only what is missing and leaves anything
 * somebody set on purpose alone.
 */

import { encodePNG } from './raster.mjs';
import { renderIcon, medallionExtent, TIGHT } from './build-app-icons.mjs';
import { GROUND } from './android-icons.mjs';

/**
 * Why the app asks, in the words iOS shows under its own prompt.
 *
 * Specific rather than "This app needs your location": App Review rejects a
 * vague purpose string, and so, more often, does the person reading it.
 */
export const IOS_USAGE = {
  NSLocationWhenInUseUsageDescription: 'Shows where you are on the map and centres it on your position.',
  NSCameraUsageDescription: 'Takes a photo to keep with a place you have saved.',
  NSPhotoLibraryAddUsageDescription: 'Saves a map snapshot to your photo library.',
};

const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Where new top-level keys go: before the dictionary that closes the plist. */
function insertAtEnd(plist, block) {
  const close = /\n?<\/dict>\s*<\/plist>\s*$/;
  if (!close.test(plist)) throw new Error('Info.plist does not end in </dict></plist> - not a file this knows how to edit.');
  return plist.replace(close, (tail) => `\n${block}${tail}`);
}

/**
 * Info.plist with the app's URL scheme and usage strings, and what was added.
 *
 * A CFBundleURLTypes that is already there is left alone even when it lacks
 * this scheme, and reported instead: merging into an array somebody else
 * wrote is where a text edit stops being safe, and a second CFBundleURLTypes
 * key would be a plist Xcode refuses.
 */
export function withIosPlist(plist, { scheme, usage = IOS_USAGE } = {}) {
  let text = String(plist || '');
  const added = [];
  const warnings = [];

  if (scheme) {
    if (!text.includes('<key>CFBundleURLTypes</key>')) {
      text = insertAtEnd(text, [
        '\t<key>CFBundleURLTypes</key>',
        '\t<array>',
        '\t\t<dict>',
        '\t\t\t<key>CFBundleURLName</key>',
        `\t\t\t<string>${escapeXml(scheme)}</string>`,
        '\t\t\t<key>CFBundleURLSchemes</key>',
        '\t\t\t<array>',
        `\t\t\t\t<string>${escapeXml(scheme)}</string>`,
        '\t\t\t</array>',
        '\t\t</dict>',
        '\t</array>',
      ].join('\n'));
      added.push('CFBundleURLTypes');
    } else if (!text.includes(`<string>${escapeXml(scheme)}</string>`)) {
      warnings.push(`Info.plist already has URL types, none of them ${scheme}. Add it in Xcode under Info → URL Types.`);
    }
  }

  for (const [key, purpose] of Object.entries(usage)) {
    if (text.includes(`<key>${key}</key>`)) continue;
    text = insertAtEnd(text, `\t<key>${key}</key>\n\t<string>${escapeXml(purpose)}</string>`);
    added.push(key);
  }

  return { text, added, warnings };
}

/**
 * project.pbxproj with the build number and version set in every
 * configuration - Debug and Release each carry their own copy.
 */
export function withIosVersion(pbxproj, version) {
  const text = String(pbxproj || '');
  if (!version) return { text, changed: false };
  const name = String(version.name).replace(/[^0-9A-Za-z.\-+]/g, '');
  const fixed = text
    .replace(/(CURRENT_PROJECT_VERSION = )[^;]+;/g, `$1${version.code};`)
    .replace(/(MARKETING_VERSION = )[^;]+;/g, `$1${name};`);
  return { text: fixed, changed: fixed !== text };
}

/** The launch image's side, as Capacitor's template sizes it. */
export const SPLASH_SIDE = 2732;

/**
 * How big the medallion is on the launch image, in its pixels.
 *
 * The storyboard draws the image aspect-fill, so on a phone its height is
 * scaled to the screen's: the medallion comes out at this × screen height /
 * 2732 points, whatever the scale factor. 460 is about 144pt on a current
 * iPhone - the size Android 12 draws its splash icon - and bigger, in
 * proportion, on an iPad.
 */
export const SPLASH_MARK = 460;

function hexToRgb(hex) {
  const value = Number.parseInt(String(hex).replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The launch image: the ground colour, the medallion in the middle. */
function splash(master, side = SPLASH_SIDE, mark = SPLASH_MARK, ground = GROUND) {
  const extent = medallionExtent(master);
  const share = extent ? (2 * extent.radius) / (master.width * TIGHT) : 1;
  const art = renderIcon(master, { size: Math.round(mark / share), shape: 'tight' });
  const [gr, gg, gb] = hexToRgb(ground);
  const rgba = new Uint8ClampedArray(side * side * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = gr; rgba[i + 1] = gg; rgba[i + 2] = gb; rgba[i + 3] = 255;
  }
  const offset = Math.round((side - art.width) / 2);
  for (let y = 0; y < art.height; y += 1) {
    for (let x = 0; x < art.width; x += 1) {
      const from = (y * art.width + x) * 4;
      const a = art.rgba[from + 3] / 255;
      if (!a) continue;
      const to = ((y + offset) * side + (x + offset)) * 4;
      rgba[to] = art.rgba[from] * a + gr * (1 - a);
      rgba[to + 1] = art.rgba[from + 1] * a + gg * (1 - a);
      rgba[to + 2] = art.rgba[from + 2] * a + gb * (1 - a);
    }
  }
  return encodePNG(side, side, rgba);
}

/**
 * Every image to write, as path under ios/App/App → PNG bytes.
 *
 * The icon is the full-bleed artwork, opaque to the corner: Apple applies its
 * own rounding, and rejects an icon with an alpha channel (ITMS-90717), which
 * encodePNG avoids by writing opaque images as RGB. The launch image is the
 * same file three times, because that is how Capacitor's asset catalogue
 * names its 1x, 2x and 3x slots.
 */
export function iosImages(master) {
  const icon = renderIcon(master, { size: 1024, shape: 'bleed' });
  const launch = splash(master);
  const files = new Map();
  files.set('Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', encodePNG(1024, 1024, icon.rgba));
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    files.set(`Assets.xcassets/Splash.imageset/${name}`, launch);
  }
  return files;
}
