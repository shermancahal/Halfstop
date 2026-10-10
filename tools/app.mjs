#!/usr/bin/env node
/**
 * The whole path from source to Xcode, in one command.
 *
 *   node tools/app.mjs ios        # or:  npm run app:ios
 *   node tools/app.mjs android    # or:  npm run app:android
 *
 * Four steps, which docs/mobile-app.md spells out and which are the same four
 * every time: build dist/ with the app token, make sure the native project
 * exists, copy dist/ into it, open the IDE. Written out because the step that
 * gets skipped is `cap sync` - editing anything under assets/ changes nothing
 * in the app until the copy has run, and a phone showing yesterday's build is
 * indistinguishable from a fix that did not work.
 *
 * Capacitor is deliberately not a dependency of this repository: `npm test`
 * runs with nothing installed and that is worth keeping. So this checks for it
 * and says what to install rather than importing it, and every native step
 * runs through `npx cap` so it is whatever version the Mac has.
 *
 * Nothing here can run in CI or in a sandbox - it needs a Mac with Xcode for
 * ios, Android Studio for android. It refuses early and by name when it is on
 * the wrong machine, which is cheaper than failing three steps in.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { androidResources, REPLACED, withSplashBackground } from './android-icons.mjs';
import { readMaster } from './build-app-icons.mjs';
import { iosImages, withIosPlist, withIosVersion } from './ios-native.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = ['ios', 'android'];

/**
 * How to install Capacitor without making it a dependency of this repository.
 *
 * `--no-save` rather than `--save-dev`, and the difference is not cosmetic.
 * The header above says Capacitor is deliberately not a dependency, and every
 * instruction used to say `--save-dev` - which writes it into package.json and
 * package-lock.json, both tracked. On the first real run on a Mac that left
 * two modified files in the clone, and the next `git pull` touching either
 * would have refused to run. `--no-save` puts it in node_modules and nowhere
 * else, which is all `npx cap` needs.
 */
export const CAPACITOR_INSTALL = 'npm install --no-save @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android '
  + '@capacitor/app @capacitor/browser @capgo/native-purchases';

/**
 * The plugins compiled into the app, and why each is there.
 *
 *   @capacitor/app            the app being opened by one of its own links -
 *                             an emailed sign-in, or the return from Google
 *   @capacitor/browser        the system browser, because Google refuses to
 *                             sign anybody in inside an embedded web view
 *   @capgo/native-purchases   Google Play Billing (and StoreKit, later)
 *
 * Named in capacitor.config.json as `includePlugins`, and that is not
 * optional here. `cap sync` finds plugins by reading package.json, and
 * `--no-save` keeps them out of package.json on purpose - so without the list,
 * sync would find none of them and build an app with no way back from Google
 * and no way to pay. A test keeps the two lists the same.
 *
 * And checked for before anything runs, because `cap sync` skips a listed
 * plugin it cannot find without saying so: it catches its own "Unable to
 * find" and carries on. The app still builds, and the button that needed the
 * plugin tells somebody to update an app that is already the newest one.
 */
export const APP_PLUGINS = ['@capacitor/app', '@capacitor/browser', '@capgo/native-purchases'];

/**
 * What stands between this machine and a build, before anything is spent.
 *
 * Pure over its inputs so the tests can ask it about a machine that does not
 * exist. Each problem carries the fix, because the person reading it is
 * standing at a terminal wanting the next command, not a diagnosis.
 */
export function preflight({ platform, os = process.platform, hasCapacitor, hasPlatformDir, missingPlugins = [] } = {}) {
  const problems = [];

  if (!PLATFORMS.includes(platform)) {
    problems.push({
      what: `"${platform}" is not a platform this builds.`,
      fix: `Use one of: ${PLATFORMS.join(', ')}.`,
    });
    return problems;
  }

  if (platform === 'ios' && os !== 'darwin') {
    problems.push({
      what: 'iOS can only be built on a Mac - Xcode does not run anywhere else.',
      fix: 'Run this on macOS with Xcode installed. There is no way around it for iOS.',
    });
  }

  if (!hasCapacitor) {
    problems.push({
      what: 'Capacitor is not installed here.',
      fix: CAPACITOR_INSTALL,
    });
  } else if (missingPlugins.length) {
    // The whole line rather than only the missing names: a partial install
    // over `--no-save` packages is what removes the ones already there.
    problems.push({
      what: `Not installed: ${missingPlugins.join(', ')}. The app would build without `
        + 'sign-in through Google or a way to pay, and nothing would say so.',
      fix: CAPACITOR_INSTALL,
    });
  }

  return problems;
}

/**
 * The permissions Android needs declared before the webview will ask for them.
 *
 * docs/mobile-app.md section 5 has always said to add these to the manifest by
 * hand, and `cap add` has always printed a line pointing at it. But android/
 * is gitignored and regenerated, so "by hand" means every fresh project, and
 * the failure when it is forgotten is quiet: the map loads, Locate is pressed,
 * nothing happens, and there is no prompt and no error to explain why. A step
 * with that failure mode belongs in the tool, not in a checklist.
 *
 * INTERNET is not listed because `cap add` writes it.
 */
export const ANDROID_PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
];

/**
 * The manifest with every permission in `wanted` declared, and which were new.
 *
 * Pure and idempotent: it runs on every build, so an android/ made before this
 * existed gets the lines too, and running it twice changes nothing the second
 * time. Refuses a manifest with no closing tag rather than guessing where a
 * line goes in a file it does not recognise.
 */
export function withAndroidPermissions(manifest, wanted = ANDROID_PERMISSIONS) {
  const missing = wanted.filter((name) => !manifest.includes(`android:name="${name}"`));
  if (!missing.length) return { manifest, added: [] };

  const at = manifest.lastIndexOf('</manifest>');
  if (at === -1) throw new Error('AndroidManifest.xml has no </manifest> - not a file this knows how to edit.');

  const lines = missing.map((name) => `    <uses-permission android:name="${name}" />`).join('\n');
  return { manifest: `${manifest.slice(0, at)}${lines}\n${manifest.slice(at)}`, added: missing };
}

/**
 * The intent filter that lets the app be opened by its own links.
 *
 * Without it, `com.halfstop.app://account` is an address nothing answers to:
 * the confirmation email, the password reset and the return from Google all
 * end on a browser page saying the address could not be opened, and the app
 * never hears about any of them. Supabase has done its part by then, so the
 * link is also spent.
 *
 * Inside the activity that launches, beside its LAUNCHER filter. That activity
 * is `singleTask`, which is what makes a link bring the running app forward
 * rather than start a second copy of it on top.
 */
export function withDeepLink(manifest, scheme) {
  if (!scheme) throw new Error('No URL scheme to register - capacitor.config.json has no appId.');
  if (manifest.includes(`android:scheme="${scheme}"`)) return { manifest, added: false };

  const launcher = manifest.indexOf('android.intent.category.LAUNCHER');
  const close = launcher === -1 ? -1 : manifest.indexOf('</intent-filter>', launcher);
  if (close === -1) {
    throw new Error('AndroidManifest.xml has no launcher intent filter - not a file this knows how to edit.');
  }

  const at = close + '</intent-filter>'.length;
  const filter = [
    '',
    '',
    '            <intent-filter>',
    '                <action android:name="android.intent.action.VIEW" />',
    '                <category android:name="android.intent.category.DEFAULT" />',
    '                <category android:name="android.intent.category.BROWSABLE" />',
    `                <data android:scheme="${scheme}" />`,
    '            </intent-filter>',
  ].join('\n');
  return { manifest: `${manifest.slice(0, at)}${filter}${manifest.slice(at)}`, added: true };
}

/**
 * Shared map links from the website, opened in the app rather than the browser.
 *
 * A link somebody sends - a view, a pin, a folder - is an ordinary
 * https://app.halfstop.app/map.html address, so that it works for anybody in
 * any browser. With this filter Android offers it to the app instead, and
 * with `autoVerify` and the site's /.well-known/assetlinks.json naming the
 * app's signing key, it goes to the app without asking. Only the map page:
 * the help, the account page and the rest stay in the browser.
 *
 * Android checks the site's file when the app is installed or updated, so
 * the file has to be live first. Without it - or before it matches the key
 * Play signs with - links simply keep opening in the browser.
 */
export const APP_LINK_HOST = 'app.halfstop.app';
export const APP_LINK_PATH = '/map.html';

export function withAppLinks(manifest, { host = APP_LINK_HOST, path: prefix = APP_LINK_PATH } = {}) {
  if (manifest.includes(`android:host="${host}"`)) return { manifest, added: false };

  const launcher = manifest.indexOf('android.intent.category.LAUNCHER');
  const close = launcher === -1 ? -1 : manifest.indexOf('</intent-filter>', launcher);
  if (close === -1) {
    throw new Error('AndroidManifest.xml has no launcher intent filter - not a file this knows how to edit.');
  }
  const at = close + '</intent-filter>'.length;
  const filter = [
    '',
    '',
    '            <intent-filter android:autoVerify="true">',
    '                <action android:name="android.intent.action.VIEW" />',
    '                <category android:name="android.intent.category.DEFAULT" />',
    '                <category android:name="android.intent.category.BROWSABLE" />',
    `                <data android:scheme="https" android:host="${host}" android:pathPrefix="${prefix}" />`,
    '            </intent-filter>',
  ].join('\n');
  return { manifest: `${manifest.slice(0, at)}${filter}${manifest.slice(at)}`, added: true };
}

/**
 * The map files Halfstop offers to open, by the types other apps send them as.
 *
 * The named types first. Then the three generic ones a map file most often
 * arrives as in practice: a GPX from Gmail or a messaging app is commonly
 * `application/octet-stream`, a GeoJSON `application/json`, a KML plain XML.
 * Listing those puts Halfstop in "Open with" for other files of the same
 * types too, which is the price of being there for the map files at all - and
 * lib/opened-file.js reads the bytes and says plainly when a file is not one.
 */
export const MAP_FILE_TYPES = [
  'application/gpx+xml',
  'application/gpx',
  'application/vnd.google-earth.kml+xml',
  'application/vnd.google-earth.kmz',
  'application/geo+json',
  'application/vnd.geo+json',
  'application/octet-stream',
  'application/json',
  'application/xml',
  'text/xml',
];

/**
 * The intent filter that puts Halfstop in Android's "Open with" for a map file.
 *
 * A VIEW of a content:// or file:// address of one of MAP_FILE_TYPES. It
 * arrives in the page as `appUrlOpen` with that address, the same door as a
 * sign-in link, and lib/native-shell.js sends it to the map to be imported.
 * Beside the launcher filter, in the singleTask activity, so a file opened
 * while the app is running comes to that copy rather than starting another.
 *
 * Pure and idempotent, like the deep link: an android/ made before this gets
 * it on the next build, and a second run changes nothing.
 */
export function withMapFiles(manifest, types = MAP_FILE_TYPES) {
  if (manifest.includes(`android:mimeType="${types[0]}"`)) return { manifest, added: false };

  const launcher = manifest.indexOf('android.intent.category.LAUNCHER');
  const close = launcher === -1 ? -1 : manifest.indexOf('</intent-filter>', launcher);
  if (close === -1) {
    throw new Error('AndroidManifest.xml has no launcher intent filter - not a file this knows how to edit.');
  }

  const at = close + '</intent-filter>'.length;
  const filter = [
    '',
    '',
    '            <intent-filter>',
    '                <action android:name="android.intent.action.VIEW" />',
    '                <category android:name="android.intent.category.DEFAULT" />',
    '                <category android:name="android.intent.category.BROWSABLE" />',
    '                <data android:scheme="content" />',
    '                <data android:scheme="file" />',
    ...types.map((type) => `                <data android:mimeType="${type}" />`),
    '            </intent-filter>',
  ].join('\n');
  return { manifest: `${manifest.slice(0, at)}${filter}${manifest.slice(at)}`, added: true };
}

/**
 * What to do once the IDE is open, for the IDE that actually opened.
 *
 * This used to print one pair of lines for both, and they were Xcode's: "pick
 * your team under Signing", and a pointer to section 6a, which is the first
 * run on an iPhone. The first real Android run ended on exactly those lines.
 * Android Studio has no team to pick for a debug build, and 6a is the wrong
 * checklist - so the lines are chosen, not shared.
 */
export function afterOpening(platform) {
  if (platform === 'android') {
    return [
      '\nIn Android Studio: let the first Gradle sync finish (it is slow once), plug the phone in',
      'with USB debugging on, pick it in the device menu, and press Run. No signing needed to test.',
      'Checklist for the first run on a real phone: docs/mobile-app.md section 6c.',
    ];
  }
  return [
    '\nIn Xcode: pick your device, pick your team under Signing, press Run.',
    'Checklist for the first run on a real phone: docs/mobile-app.md section 6a.',
  ];
}

/**
 * The Android Gradle Plugin a Capacitor 8 project is generated with, and what
 * it looks like when Android Studio has moved it on.
 *
 * `cap add android` writes AGP 8.13.0. Android Studio then offers - and, if
 * the notification is accepted, performs - an upgrade to AGP 9, whose upgrade
 * assistant adds seven `android.*=false` compatibility options to
 * gradle.properties and leaves Capacitor's `proguard-android.txt` line in
 * place, which AGP 9 refuses outright. The first real Android build failed
 * exactly that way, reported as "are we sure Halfstop is even loaded?",
 * because the only line in red named a proguard file.
 *
 * Capacitor 8 is built and tested against AGP 8. Rather than patch its
 * template to survive a plugin version it does not support, this notices the
 * drift and says how to undo it. android/ is gitignored and regenerated, so
 * undoing it costs one command.
 */
export const AGP_SUPPORTED_MAJOR = 8;

/** The major version of the Android Gradle Plugin a build.gradle asks for, or null. */
export function agpMajor(buildGradle) {
  const match = /com\.android\.tools\.build:gradle:(\d+)\./.exec(String(buildGradle || ''));
  return match ? Number(match[1]) : null;
}

/** A warning when the project has left the plugin Capacitor supports, or null. */
export function agpDrift(buildGradle) {
  const major = agpMajor(buildGradle);
  if (major === null || major <= AGP_SUPPORTED_MAJOR) return null;
  return `android/ is on Android Gradle Plugin ${major} - Android Studio's upgrade, not Capacitor's. `
    + `Capacitor 8 is built against AGP ${AGP_SUPPORTED_MAJOR}. The one line known to break is fixed below; `
    + 'if the build still fails on something that names Gradle rather than Halfstop, this is the first '
    + 'suspect: rm -rf android, run this again, and dismiss the "Upgrade Android Gradle Plugin" notification.';
}

/**
 * The proguard line in Capacitor's template, in the form both plugins accept.
 *
 * `cap add android` writes `getDefaultProguardFile('proguard-android.txt')`.
 * AGP 8 accepts it; AGP 9 refuses it outright, because that file carries
 * `-dontoptimize`. Declining Android Studio's upgrade to AGP 9 was the first
 * answer, and it did not hold - the first real build came back from a fresh
 * project still on AGP 9, still failing on this line.
 *
 * So the line is rewritten to `proguard-android-optimize.txt`, which both
 * accept. It changes nothing about the app: the template sets
 * `minifyEnabled false`, so neither file is ever read. The plugin only
 * refuses to parse the old name, used or not.
 */
export function withSupportedProguard(appBuildGradle) {
  const text = String(appBuildGradle || '');
  const fixed = text.replace(/getDefaultProguardFile\((['"])proguard-android\.txt\1\)/g,
    (_, quote) => `getDefaultProguardFile(${quote}proguard-android-optimize.txt${quote})`);
  return { text: fixed, changed: fixed !== text };
}

/**
 * The Gradle project's name, so Android Studio says Halfstop rather than
 * "android".
 *
 * Capacitor's settings.gradle names no root project, so Gradle takes the
 * folder's name - and the folder has to be called `android`, because that is
 * where Capacitor looks. The name people see on the phone is a different
 * thing, `app_name`, which `cap add` already writes from capacitor.config.json;
 * this is only what the IDE calls the project in its window and its Project
 * pane. The module stays `app` for the same reason the folder stays `android`.
 *
 * Replaces an existing name rather than adding a second one, so a project
 * somebody renamed by hand ends up with the same name as everybody else's.
 */
export function withProjectName(settingsGradle, name) {
  const text = String(settingsGradle || '');
  if (!name) return { text, changed: false };
  const line = `rootProject.name = '${String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const existing = /^\s*rootProject\.name\s*=.*$/m;
  const fixed = existing.test(text) ? text.replace(existing, line) : `${line}\n${text}`;
  return { text: fixed, changed: fixed !== text };
}

/**
 * The version Play and the App Store see, from this repository.
 *
 * Play refuses an upload whose versionCode it has seen before, and
 * `cap add android` writes 1 - so the second upload failed until somebody
 * remembered to edit a file in a gitignored folder. The code is the number
 * of commits on HEAD instead: it only ever grows as the app changes, needs
 * nobody to remember it, and two builds of the same commit are the same
 * build, which Play is right to treat as one.
 *
 * The name people see ends in that same number: major.minor from
 * package.json, then the build - 1.0.640. Every build, a fix or not, moves
 * the name on by itself, and the store, the app's build line and Play
 * Console's release name all say the same thing. A release worth naming
 * raises package.json from 1.0 to 1.1, and its own third number is ignored.
 *
 * @returns {{ code: number, name: string } | null} null when git cannot say
 */
export function versionFor({ commits, shallow = false, packageVersion = '' } = {}) {
  const code = Number.parseInt(String(commits ?? '').trim(), 10);
  // A shallow clone counts only what it fetched, which can be fewer commits
  // than an upload Play has already seen. Refusing to guess is better than a
  // build Play rejects at the end of an upload.
  if (!Number.isInteger(code) || code < 1 || shallow) return null;
  const [major, minor] = String(packageVersion || '').trim().split('.')
    .map((part) => Number.parseInt(part, 10));
  const series = Number.isInteger(major) && major >= 0
    ? `${major}.${Number.isInteger(minor) && minor >= 0 ? minor : 0}`
    : '1.0';
  return { code, name: `${series}.${code}` };
}

/**
 * build.json with the app's version in it, for the build line in the panel.
 *
 * Written into dist/ before `cap sync` copies it, so the version on the
 * store page is the one the app says it is - which is what a tester reading
 * it out in a bug report needs.
 */
export function withAppVersion(buildJson, version) {
  const text = String(buildJson || '');
  if (!version) return { text, changed: false };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { text, changed: false };
  }
  if (data.version === version.name) return { text, changed: false };
  const fixed = `${JSON.stringify({ ...data, version: version.name })}\n`;
  return { text: fixed, changed: true };
}

/** app/build.gradle with the version set, and whether that changed it. */
export function withVersion(appBuildGradle, version) {
  const text = String(appBuildGradle || '');
  if (!version) return { text, changed: false };
  // `versionCode 1` as Capacitor writes it, or `versionCode = 1` as Android
  // Studio's plugin upgrade rewrites it.
  const fixed = text
    .replace(/(\bversionCode\s*=?\s*)\d+/, `$1${version.code}`)
    .replace(/(\bversionName\s*=?\s*)"[^"]*"/, `$1"${version.name.replace(/"/g, '')}"`);
  return { text: fixed, changed: fixed !== text };
}

/** Whether a build.gradle carries this version, read back after writing it. */
export function carriesVersion(appBuildGradle, version) {
  const text = String(appBuildGradle || '');
  return new RegExp(`\\bversionCode\\s*=?\\s*${version.code}\\b`).test(text)
    && text.includes(`"${version.name}"`);
}

/** Commits on HEAD, and whether this clone has all of them. */
function gitVersion() {
  const count = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' });
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return versionFor({
    commits: count.status === 0 ? count.stdout : '',
    shallow: shallow.status === 0 && shallow.stdout.trim() === 'true',
    packageVersion: pkg.version,
  });
}

/** Whether `npx cap` will find anything. Local install only, on purpose. */
function capacitorInstalled() {
  return existsSync(path.join(ROOT, 'node_modules', '@capacitor', 'cli'));
}

/** The app's plugins that node_modules does not have. */
function pluginsMissing() {
  return APP_PLUGINS.filter((name) => !existsSync(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json')));
}

/** capacitor.config.json, which names the app and therefore its URL scheme. */
function capacitorConfig() {
  return JSON.parse(readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
}

function run(label, command, args) {
  console.log(`\n>> ${label}\n  $ ${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${result.status ?? 'signal'}). Stopping here.`);
    process.exit(result.status || 1);
  }
}

/**
 * Put the Halfstop mark into res/, replacing Capacitor's logo.
 *
 * Every run, like the manifest and Gradle edits: android/ is regenerated, and
 * an icon is exactly the kind of thing that is fixed by hand once and quietly
 * lost with the folder. Writes only what differs, so a run that changes
 * nothing says nothing. See tools/android-icons.mjs for what each file is.
 */
export async function writeAndroidIcons(res = path.join(ROOT, 'android', 'app', 'src', 'main', 'res'), { master = null } = {}) {
  const files = androidResources(master || await readMaster());
  let written = 0;
  for (const [relative, contents] of files) {
    const target = path.join(res, relative);
    const bytes = typeof contents === 'string' ? Buffer.from(contents) : Buffer.from(contents);
    if (existsSync(target) && readFileSync(target).equals(bytes)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    written += 1;
  }
  let removed = 0;
  for (const relative of REPLACED) {
    const target = path.join(res, relative);
    if (!existsSync(target)) continue;
    rmSync(target);
    removed += 1;
  }
  const stylesPath = path.join(res, 'values', 'styles.xml');
  if (existsSync(stylesPath)) {
    const styled = withSplashBackground(readFileSync(stylesPath, 'utf8'));
    if (styled.changed) { writeFileSync(stylesPath, styled.text); written += 1; }
  }
  return { written, removed };
}

/**
 * Everything tools/ios-native.mjs knows the iPhone project needs, written in.
 * Only what differs is written, and each change is said once.
 */
export async function patchIos(appDir = path.join(ROOT, 'ios', 'App'), { master = null, version = undefined } = {}) {
  const plistPath = path.join(appDir, 'App', 'Info.plist');
  const plist = withIosPlist(readFileSync(plistPath, 'utf8'), { scheme: capacitorConfig().appId });
  if (plist.added.length) {
    writeFileSync(plistPath, plist.text);
    console.log(`\n>> Info.plist: added ${plist.added.join(', ')}`);
  }
  for (const line of plist.warnings) console.warn(`\n  WARNING: ${line}`);

  let written = 0;
  for (const [relative, bytes] of iosImages(master || await readMaster())) {
    const target = path.join(appDir, 'App', relative);
    const buffer = Buffer.from(bytes);
    if (existsSync(target) && readFileSync(target).equals(buffer)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, buffer);
    written += 1;
  }
  if (written) console.log(`\n>> The Halfstop icon and launch image are in Assets.xcassets (${written} written)`);

  const pbxPath = path.join(appDir, 'App.xcodeproj', 'project.pbxproj');
  const chosen = version === undefined ? gitVersion() : version;
  if (!chosen) {
    console.warn('\n  WARNING: could not count this clone\'s commits, so the build number was left as it is.');
  } else if (existsSync(pbxPath)) {
    const versioned = withIosVersion(readFileSync(pbxPath, 'utf8'), chosen);
    if (versioned.changed) writeFileSync(pbxPath, versioned.text);
    console.log(`\n>> Version ${chosen.name} (${chosen.code})`);
  }
  return { added: plist.added, warnings: plist.warnings, written };
}

async function main() {
  const platform = process.argv[2];
  const problems = preflight({
    platform,
    hasCapacitor: capacitorInstalled(),
    hasPlatformDir: platform ? existsSync(path.join(ROOT, platform)) : false,
    missingPlugins: pluginsMissing(),
  });

  if (problems.length) {
    console.error('Not building yet:\n');
    for (const problem of problems) {
      console.error(`  ${problem.what}`);
      console.error(`    → ${problem.fix}\n`);
    }
    process.exit(1);
  }

  // 1. The web bundle, with the app's token. Never `npm run dist` here: that
  //    stages the website's URL-restricted token, and cap sync would copy it
  //    straight into a webview that sends no Referer.
  run('Build dist/ with the app token', process.execPath, [path.join(ROOT, 'tools', 'build-dist.mjs'), '--app']);

  // 2. The native project, created once. `cap add` refuses to run twice, so
  //    this is the one step that is conditional.
  if (!existsSync(path.join(ROOT, platform))) {
    run(`Create the ${platform} project`, 'npx', ['cap', 'add', platform]);
  }

  // 2a. Android's permissions and its link handling, every run rather than
  //     only on creation, so a project made before these steps existed is
  //     brought up to date too.
  if (platform === 'android') {
    // Before anything is copied in: a project Android Studio has moved to a
    // plugin Capacitor does not support will fail in the IDE, and the IDE's
    // error names a proguard file rather than the upgrade that caused it.
    const drift = agpDrift(readFileSync(path.join(ROOT, 'android', 'build.gradle'), 'utf8'));
    if (drift) console.warn(`\n  WARNING: ${drift}`);

    const settingsPath = path.join(ROOT, 'android', 'settings.gradle');
    const named = withProjectName(readFileSync(settingsPath, 'utf8'), capacitorConfig().appName);
    if (named.changed) {
      writeFileSync(settingsPath, named.text);
      console.log(`\n>> settings.gradle: the project is called ${capacitorConfig().appName} in Android Studio now`);
    }

    const appGradlePath = path.join(ROOT, 'android', 'app', 'build.gradle');
    const proguard = withSupportedProguard(readFileSync(appGradlePath, 'utf8'));
    if (proguard.changed) {
      writeFileSync(appGradlePath, proguard.text);
      console.log('\n>> app/build.gradle: proguard-android.txt -> proguard-android-optimize.txt (AGP 9 refuses the old name)');
    }

    const version = gitVersion();
    if (!version) {
      console.warn('\n  WARNING: could not count this clone\'s commits (not a git clone, or a shallow one), so the '
        + 'version was left as it is. Play refuses an upload with a versionCode it has already seen.');
    } else {
      const versioned = withVersion(readFileSync(appGradlePath, 'utf8'), version);
      if (versioned.changed) writeFileSync(appGradlePath, versioned.text);
      // Read back rather than assumed: a build.gradle laid out some other way
      // takes neither line, and an upload numbered 1 is refused by Play.
      if (carriesVersion(readFileSync(appGradlePath, 'utf8'), version)) {
        console.log(`\n>> Version ${version.name} (code ${version.code}) - use "${version.name}" as the release name in Play Console`);
      } else {
        console.warn(`\n  WARNING: could not set the version in android/app/build.gradle - it still is not `
          + `versionCode ${version.code} / versionName "${version.name}". Do not upload this build; Play refuses `
          + 'a version code it has seen. Send the defaultConfig block from that file to be looked at.');
      }
    }

    const manifestPath = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const before = readFileSync(manifestPath, 'utf8');
    const { manifest: permitted, added } = withAndroidPermissions(before);
    if (added.length) {
      console.log(`\n>> Declared in AndroidManifest.xml: ${added.map((name) => name.split('.').pop()).join(', ')}`);
    }
    const icons = await writeAndroidIcons();
    if (icons.written || icons.removed) {
      console.log(`\n>> The Halfstop icon and splash are in res/ (${icons.written} written, ${icons.removed} of Capacitor's removed)`);
    }

    const scheme = capacitorConfig().appId;
    const linked = withDeepLink(permitted, scheme);
    if (linked.added) console.log(`\n>> AndroidManifest.xml now opens ${scheme}:// links (sign-in emails, the return from Google)`);
    const files = withMapFiles(linked.manifest);
    if (files.added) console.log('\n>> AndroidManifest.xml now offers Halfstop in "Open with" for GPX, KML, KMZ and GeoJSON files');
    const shared = withAppLinks(files.manifest);
    if (shared.added) console.log(`\n>> AndroidManifest.xml now opens ${APP_LINK_HOST}${APP_LINK_PATH} links in the app`);
    if (shared.manifest !== before) writeFileSync(manifestPath, shared.manifest);
  }

  // 2b. The iPhone project's link handling, permission strings, icon, launch
  //     image and version - every run, for the same reason as 2a.
  if (platform === 'ios') await patchIos();

  // 2c. The version into the bundle's build.json, so the app's build line
  //     names the version the store does.
  const buildJsonPath = path.join(ROOT, 'dist', 'build.json');
  if (existsSync(buildJsonPath)) {
    const stamped = withAppVersion(readFileSync(buildJsonPath, 'utf8'), gitVersion());
    if (stamped.changed) writeFileSync(buildJsonPath, stamped.text);
  }

  // 3. The copy. This is the step people forget.
  run(`Copy dist/ into ${platform}/`, 'npx', ['cap', 'sync', platform]);

  // 4. The IDE.
  run(`Open ${platform === 'ios' ? 'Xcode' : 'Android Studio'}`, 'npx', ['cap', 'open', platform]);

  for (const line of afterOpening(platform)) console.log(line);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
