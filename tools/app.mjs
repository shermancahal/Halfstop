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
 * What stands between this machine and a build, before anything is spent.
 *
 * Pure over its inputs so the tests can ask it about a machine that does not
 * exist. Each problem carries the fix, because the person reading it is
 * standing at a terminal wanting the next command, not a diagnosis.
 */
export function preflight({ platform, os = process.platform, hasCapacitor, hasPlatformDir } = {}) {
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
      fix: 'npm install --save-dev @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android',
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

/** Whether `npx cap` will find anything. Local install only, on purpose. */
function capacitorInstalled() {
  return existsSync(path.join(ROOT, 'node_modules', '@capacitor', 'cli'));
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

  // 2a. Android's permissions, every run rather than only on creation, so a
  //     project made before this step existed is brought up to date too.
  if (platform === 'android') {
    const manifestPath = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const { manifest, added } = withAndroidPermissions(readFileSync(manifestPath, 'utf8'));
    if (added.length) {
      writeFileSync(manifestPath, manifest);
      console.log(`\n>> Declared in AndroidManifest.xml: ${added.map((name) => name.split('.').pop()).join(', ')}`);
    }
  }

  // 3. The copy. This is the step people forget.
  run(`Copy dist/ into ${platform}/`, 'npx', ['cap', 'sync', platform]);

  // 4. The IDE.
  run(`Open ${platform === 'ios' ? 'Xcode' : 'Android Studio'}`, 'npx', ['cap', 'open', platform]);

  console.log('\nIn the IDE: pick your device, pick your team under Signing, press Run.');
  console.log('Checklist for the first run on a real phone: docs/mobile-app.md section 6a.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
