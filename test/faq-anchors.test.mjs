/**
 * Links into the help page, which are URLs other people keep.
 *
 * Once a support reply or the privacy policy says faq.html#syncing, that id is
 * a promise: renaming it, or dropping it when a question is rewritten, breaks
 * a link somebody saved, with no error anywhere - the page just opens at the
 * top. So every question and section must have an id, no two may share one,
 * and every link to faq.html#... in the repository must land on something.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { answerLink } from '../assets/js/lib/faq-anchors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const faq = await readFile(path.join(ROOT, 'faq.html'), 'utf8');
const allIds = [...faq.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

const questions = [...faq.matchAll(/<details class="faq-item"([^>]*)>\s*<summary><h3>(.*?)<\/h3>/g)]
  .map(([, attributes, title]) => ({ id: attributes.match(/id="([^"]+)"/)?.[1] || null, title }));
const sections = [...faq.matchAll(/<section class="faq-section"([^>]*)>\s*<h2>(.*?)<\/h2>/g)]
  .map(([, attributes, title]) => ({ id: attributes.match(/id="([^"]+)"/)?.[1] || null, title }));

test('faq anchors: every question and every section has an id', () => {
  assert.ok(questions.length >= 30, `found only ${questions.length} questions`);
  assert.deepEqual(questions.filter((question) => !question.id).map((question) => question.title), []);
  assert.deepEqual(sections.filter((section) => !section.id).map((section) => section.title), []);
});

test('faq anchors: no two things on the page share an id, and each reads as a word', () => {
  const seen = new Set();
  const twice = allIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(twice, []);
  for (const { id } of [...questions, ...sections]) {
    // Lower case and hyphens: what survives being typed, pasted into a chat
    // and read aloud over the phone.
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${id} is not a tidy anchor`);
  }
});

test('faq anchors: the index at the top names every section', () => {
  const indexed = [...faq.matchAll(/<ul class="faq-index">([\s\S]*?)<\/ul>/g)][0]?.[1] || '';
  const linked = [...indexed.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(linked.filter((id) => !allIds.includes(id)), [], 'the index links to a section that is not there');
  assert.deepEqual(sections.map((section) => section.id).filter((id) => !linked.includes(id)), [],
    'a section the index does not list');
});

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'android', 'ios', '.git', 'vendor'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(html|js|mjs|md|ts)$/.test(entry.name)) yield full;
  }
}

test('faq anchors: every link into the help page lands on something', async () => {
  const broken = [];
  let found = 0;
  for await (const file of sourceFiles(ROOT)) {
    const text = await readFile(file, 'utf8');
    for (const [, id] of text.matchAll(/faq\.html#([a-z0-9-]+)/g)) {
      found += 1;
      if (!allIds.includes(id)) broken.push(`${path.relative(ROOT, file)} -> #${id}`);
    }
  }
  assert.ok(found > 0, 'no links into the help page found at all - is the scan looking in the right place?');
  assert.deepEqual(broken, []);
});

test('faq anchors: a copied link is the published address inside the app, and this one on the web', () => {
  const site = 'https://app.halfstop.app/';
  assert.equal(answerLink({ id: 'syncing', href: 'capacitor://localhost/faq.html', protocol: 'capacitor:', site }),
    'https://app.halfstop.app/faq.html#syncing');
  assert.equal(answerLink({ id: 'syncing', href: 'https://preview.example.com/halfstop/faq.html', protocol: 'https:', site }),
    'https://preview.example.com/halfstop/faq.html#syncing');
});

test('faq anchors: no id on any page shadows a global a script looks for', async () => {
  /*
   * An element with an id is also a property of window, and the bundled
   * libraries decide how to load by asking about globals. The vendored
   * supabase.js begins `"object"==typeof exports ? exports.supabase = ...`,
   * so the day the help page gained <details id="exports"> it loaded itself
   * onto that answer instead of onto window, and the account on that page
   * never started - signed in everywhere else, signed out there, with no
   * error anywhere. The id is "exporting" now; this keeps the whole family
   * of names off every page.
   */
  const reserved = ['exports', 'module', 'define', 'require', 'global', 'globalThis', 'process', 'self',
    'supabase', 'maplibregl', 'mapboxgl', 'Capacitor'];
  const pages = (await readdir(ROOT)).filter((name) => name.endsWith('.html'));
  const clashes = [];
  for (const page of pages) {
    const html = await readFile(path.join(ROOT, page), 'utf8');
    for (const [, id] of html.matchAll(/\s(?:id|name)="([^"]+)"/g)) {
      if (reserved.includes(id)) clashes.push(`${page}: ${id}`);
    }
  }
  assert.deepEqual(clashes, []);
});
