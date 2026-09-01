import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

/*
 * The repository root is a short, stable list, and it should stay that way.
 *
 * Two throwaway scripts - a static file server and a browser probe, both
 * written to check something by hand - were swept into a commit by `git add
 * -A` and shipped as part of the repository. Nothing broke: the dist build
 * copies `assets` and `data` and three named pages, so neither reached the
 * site. They were simply litter in the first thing anybody sees, left by
 * somebody who was in a hurry and did not read what they were staging.
 *
 * The root is the one directory where a complete list is practical, so this is
 * the one place a check like this earns its keep. A new file here is either a
 * real addition worth naming, or it is exactly this mistake.
 */
const ALLOWED = new Set([
  '.gitignore', '.nojekyll',
  'README.md',
  'capacitor.config.json',
  'faq.html', 'index.html', 'map.html',
  'manifest.webmanifest',
  'package.json', 'package-lock.json',
  'sw.js',
  // Directories.
  '.git', '.github', 'assets', 'data', 'dist', 'docs', 'node_modules', 'supabase', 'test', 'tools',
]);

test('repo: nothing unexpected is sitting in the repository root', async () => {
  const here = new URL('../', import.meta.url);
  const found = (await readdir(here)).filter((name) => !ALLOWED.has(name)).sort();

  assert.deepEqual(found, [],
    'add it to the list if it belongs, delete it if it was scratch work');
});
