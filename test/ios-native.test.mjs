/**
 * The iPhone project's edits, checked against the file Capacitor writes.
 *
 * test/fixtures/capacitor-ios-Info.plist is `cap add ios`'s Info.plist, as of
 * Capacitor 8.5.2, copied rather than written from memory: the edits are text
 * edits, and the only honest test of one is the text it will meet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  APPLE_SIGN_IN, ENTITLEMENTS_FILE, IOS_USAGE, SPLASH_SIDE, SPLASH_MARK, iosImages, withAppleSignIn,
  withEntitlementsSetting, withIosPlist, withIosVersion,
} from '../tools/ios-native.mjs';
import { readMaster } from '../tools/build-app-icons.mjs';
import { decodePNG } from '../tools/raster.mjs';
import { APP_SCHEME } from '../assets/js/lib/native-shell.js';
import { patchIos } from '../tools/app.mjs';

const TEMPLATE = readFileSync(new URL('./fixtures/capacitor-ios-Info.plist', import.meta.url), 'utf8');
const master = await readMaster();

test('ios: the app answers to its own scheme, so links come back to it and not to Safari', () => {
  const { text, added } = withIosPlist(TEMPLATE, { scheme: APP_SCHEME });
  assert.ok(added.includes('CFBundleURLTypes'));
  assert.match(text, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>com\.halfstop\.app<\/string>\s*<\/array>/);
  // Still one plist, closed where it was.
  assert.match(text, /<\/dict>\n<\/plist>\n?$/);
  assert.equal(text.match(/<plist/g).length, 1);
});

test('ios: every permission the app uses says why, including the camera', () => {
  // The photo picker offers Take Photo. Opening the camera without this
  // string closes the app rather than asking.
  const { text } = withIosPlist(TEMPLATE, { scheme: APP_SCHEME });
  for (const [key, purpose] of Object.entries(IOS_USAGE)) {
    assert.ok(text.includes(`<key>${key}</key>\n\t<string>${purpose}</string>`), key);
  }
  assert.ok('NSCameraUsageDescription' in IOS_USAGE);
});

test('ios: export compliance is answered in the build, not on every upload', () => {
  // HTTPS only, which is exempt. Without the key every build waits at
  // "Missing Compliance" in App Store Connect until somebody answers by hand.
  const { text, added } = withIosPlist(TEMPLATE, { scheme: APP_SCHEME });
  assert.ok(added.includes('ITSAppUsesNonExemptEncryption'));
  assert.match(text, /<key>ITSAppUsesNonExemptEncryption<\/key>\n\t<false\/>/);
  // An answer somebody set in Xcode is theirs.
  const set = TEMPLATE.replace('</dict>\n</plist>',
    '\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<true/>\n</dict>\n</plist>');
  const kept = withIosPlist(set, { scheme: APP_SCHEME });
  assert.ok(!kept.added.includes('ITSAppUsesNonExemptEncryption'));
  assert.equal(kept.text.match(/ITSAppUsesNonExemptEncryption/g).length, 1);
});

test('ios: running it again adds nothing, and a string somebody set is kept', () => {
  const once = withIosPlist(TEMPLATE, { scheme: APP_SCHEME }).text;
  assert.deepEqual(withIosPlist(once, { scheme: APP_SCHEME }), { text: once, added: [], warnings: [] });

  const custom = TEMPLATE.replace('</dict>\n</plist>',
    '\t<key>NSCameraUsageDescription</key>\n\t<string>Our own words.</string>\n</dict>\n</plist>');
  const { text, added } = withIosPlist(custom, { scheme: APP_SCHEME });
  assert.ok(!added.includes('NSCameraUsageDescription'));
  assert.ok(text.includes('Our own words.'));
  assert.equal(text.match(/NSCameraUsageDescription/g).length, 1);
});

test('ios: URL types somebody else wrote are reported, not merged into', () => {
  const other = TEMPLATE.replace('</dict>\n</plist>',
    '\t<key>CFBundleURLTypes</key>\n\t<array><dict><key>CFBundleURLSchemes</key><array><string>other</string></array></dict></array>\n</dict>\n</plist>');
  const { text, added, warnings } = withIosPlist(other, { scheme: APP_SCHEME });
  assert.ok(!added.includes('CFBundleURLTypes'));
  assert.equal(text.match(/CFBundleURLTypes/g).length, 1);
  assert.match(warnings[0], /com\.halfstop\.app/);
});

test('ios: a file that is not a plist is refused', () => {
  assert.throws(() => withIosPlist('<html></html>', { scheme: APP_SCHEME }), /not a file this knows how to edit/);
});

const PBX = `				CURRENT_PROJECT_VERSION = 1;
				INFOPLIST_FILE = App/Info.plist;
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.halfstop.app;
			};
			name = Debug;
		};
				CURRENT_PROJECT_VERSION = 1;
				INFOPLIST_FILE = App/Info.plist;
				MARKETING_VERSION = 1.0;
			};
			name = Release;`;

test('ios: both configurations carry the build number and version', () => {
  const { text, changed } = withIosVersion(PBX, { code: 185, name: '0.1.0' });
  assert.equal(changed, true);
  assert.equal(text.match(/CURRENT_PROJECT_VERSION = 185;/g).length, 2);
  assert.equal(text.match(/MARKETING_VERSION = 0\.1\.0;/g).length, 2);
  assert.ok(text.includes('PRODUCT_BUNDLE_IDENTIFIER = com.halfstop.app;'));
  assert.deepEqual(withIosVersion(PBX, null), { text: PBX, changed: false });
});

const images = iosImages(master);

test('ios: the icon is the full artwork, 1024 square, with no alpha channel', () => {
  // Apple rounds the corners itself, and rejects an icon with an alpha
  // channel at upload (ITMS-90717).
  const bytes = images.get('Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
  const icon = decodePNG(bytes);
  assert.equal(icon.width, 1024);
  assert.equal(bytes[25], 2, 'colour type is not RGB');
});

test('ios: the launch image is the ground colour with the medallion centred at its size', () => {
  const names = [...images.keys()].filter((name) => name.includes('Splash.imageset'));
  assert.equal(names.length, 3);
  const launch = decodePNG(images.get(names[0]));
  assert.equal(launch.width, SPLASH_SIDE);
  const at = (x, y) => [...launch.rgba.slice((y * launch.width + x) * 4, (y * launch.width + x) * 4 + 3)];
  assert.deepEqual(at(0, 0), [0x1f, 0x28, 0x46]);
  // Find the medallion's extent along the middle row.
  const row = SPLASH_SIDE / 2;
  let left = -1; let right = -1;
  for (let x = 0; x < SPLASH_SIDE; x += 1) {
    const [r, g, b] = at(x, row);
    if (Math.abs(r - 0x1f) + Math.abs(g - 0x28) + Math.abs(b - 0x46) > 40) {
      if (left < 0) left = x;
      right = x;
    }
  }
  assert.ok(Math.abs((right - left + 1) - SPLASH_MARK) <= 8, `the medallion is ${right - left + 1}px, not ${SPLASH_MARK}`);
  assert.ok(Math.abs((left + right) / 2 - SPLASH_SIDE / 2) <= 2, 'the medallion is off centre');
});

test('ios: written into a Capacitor project, and a second run writes nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'halfstop-ios-'));
  try {
    mkdirSync(path.join(dir, 'App'), { recursive: true });
    mkdirSync(path.join(dir, 'App.xcodeproj'), { recursive: true });
    writeFileSync(path.join(dir, 'App', 'Info.plist'), TEMPLATE);
    writeFileSync(path.join(dir, 'App.xcodeproj', 'project.pbxproj'), PBX);
    const version = { code: 185, name: '0.1.0' };

    const first = await patchIos(dir, { master, version });
    assert.ok(first.added.includes('CFBundleURLTypes'));
    assert.equal(first.written, 4);
    assert.ok(existsSync(path.join(dir, 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png')));
    const pbx = readFileSync(path.join(dir, 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    assert.match(pbx, /CURRENT_PROJECT_VERSION = 185;/);
    assert.equal(pbx.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g).length, 2);
    const entitlements = path.join(dir, ENTITLEMENTS_FILE);
    assert.ok(readFileSync(entitlements, 'utf8').includes(`<key>${APPLE_SIGN_IN}</key>`));

    const second = await patchIos(dir, { master, version });
    assert.deepEqual([second.added, second.written], [[], 0]);
    assert.equal(readFileSync(path.join(dir, 'App.xcodeproj', 'project.pbxproj'), 'utf8'), pbx, 'nothing added twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Sign in with Apple needs an entitlement, and Capacitor's template has no
 * entitlements file. Without it the sheet never opens - the request fails at
 * once with error 1000 - and ios/ is regenerated, so ticking the capability in
 * Xcode by hand lasts until the next clean checkout.
 */
test('ios: the app target is pointed at an entitlements file, once', () => {
  const first = withEntitlementsSetting(PBX);
  assert.equal(first.changed, true);
  assert.equal(first.file, ENTITLEMENTS_FILE);
  // Beside each configuration's Info.plist, with the same indentation.
  assert.match(first.text, /\t\t\t\tCODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;\n\t\t\t\tINFOPLIST_FILE = App\/Info\.plist;/);
  assert.equal(first.text.match(/CODE_SIGN_ENTITLEMENTS/g).length, 2);

  const again = withEntitlementsSetting(first.text);
  assert.deepEqual([again.changed, again.file], [false, ENTITLEMENTS_FILE]);

  // One that Xcode already named, when the capability was ticked by hand, is
  // the file used - not a second one beside it.
  const byHand = PBX.replace(/INFOPLIST_FILE/g, 'CODE_SIGN_ENTITLEMENTS = "App/Halfstop.entitlements";\n\t\t\t\tINFOPLIST_FILE');
  assert.deepEqual(withEntitlementsSetting(byHand), { text: byHand, changed: false, file: 'App/Halfstop.entitlements' });

  assert.deepEqual(withEntitlementsSetting('nothing here'), { text: 'nothing here', changed: false, file: '' });
});

test('ios: the entitlements file carries Sign in with Apple, and keeps what else it holds', () => {
  const made = withAppleSignIn('');
  assert.equal(made.changed, true);
  assert.match(made.text, /^<\?xml/);
  assert.match(made.text, new RegExp(`<key>${APPLE_SIGN_IN.replace(/\./g, '\\.')}</key>\\s*<array>\\s*<string>Default</string>\\s*</array>`));
  assert.deepEqual(withAppleSignIn(made.text), { text: made.text, changed: false });

  const other = made.text.replace(/\t<key>com\.apple\.developer\.applesignin[\s\S]*?<\/array>\n?/, '\t<key>aps-environment</key>\n\t<string>development</string>\n');
  assert.ok(!other.includes(APPLE_SIGN_IN), 'the fixture is a file without it');
  const merged = withAppleSignIn(other);
  assert.equal(merged.changed, true);
  assert.ok(merged.text.includes('<key>aps-environment</key>'));
  assert.ok(merged.text.includes(`<key>${APPLE_SIGN_IN}</key>`));
  assert.throws(() => withAppleSignIn('<html></html>'), /entitlements file does not end/);
});
