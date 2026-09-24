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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function main() {
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
    if (platform === 'ios') {
      console.log('\nios/ is new and gitignored. Info.plist permissions still need adding - see docs/mobile-app.md section 5.');
    }
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

    const appGradlePath = path.join(ROOT, 'android', 'app', 'build.gradle');
    const proguard = withSupportedProguard(readFileSync(appGradlePath, 'utf8'));
    if (proguard.changed) {
      writeFileSync(appGradlePath, proguard.text);
      console.log('\n>> app/build.gradle: proguard-android.txt -> proguard-android-optimize.txt (AGP 9 refuses the old name)');
    }

    const manifestPath = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const before = readFileSync(manifestPath, 'utf8');
    const { manifest: permitted, added } = withAndroidPermissions(before);
    if (added.length) {
      console.log(`\n>> Declared in AndroidManifest.xml: ${added.map((name) => name.split('.').pop()).join(', ')}`);
    }
    const scheme = capacitorConfig().appId;
    const linked = withDeepLink(permitted, scheme);
    if (linked.added) console.log(`\n>> AndroidManifest.xml now opens ${scheme}:// links (sign-in emails, the return from Google)`);
    if (linked.manifest !== before) writeFileSync(manifestPath, linked.manifest);
  }

  // 3. The copy. This is the step people forget.
  run(`Copy dist/ into ${platform}/`, 'npx', ['cap', 'sync', platform]);

  // 4. The IDE.
  run(`Open ${platform === 'ios' ? 'Xcode' : 'Android Studio'}`, 'npx', ['cap', 'open', platform]);

  for (const line of afterOpening(platform)) console.log(line);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
