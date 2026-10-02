/**
 * The status bar of the site installed to an iPhone's home screen.
 *
 * "black-translucent" draws the page under the status bar, which looks
 * better on paper - and on iOS 26 it has the installed app sized a status
 * bar's height short of the screen, so a blank strip sat under the map that
 * nothing in the page could paint. "black" keeps the window full height.
 * Every page carries it, because iOS reads it from whichever page the app was
 * launched or navigated to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ios status bar: every page asks for the opaque bar, none for the translucent one', async () => {
  const pages = (await readdir(ROOT)).filter((name) => name.endsWith('.html'));
  assert.ok(pages.length >= 8, `found only ${pages.length} pages`);
  for (const page of pages) {
    const html = await readFile(path.join(ROOT, page), 'utf8');
    const styles = [...html.matchAll(/<meta name="apple-mobile-web-app-status-bar-style" content="([^"]*)">/g)]
      .map((match) => match[1]);
    assert.deepEqual(styles, ['black'], `${page} sets ${styles.join(', ') || 'no status bar style'}`);
  }
});
