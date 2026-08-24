import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * A guard against a specific, repeated, self-inflicted bug.
 *
 * Four times now a character from another script has landed in the middle of a
 * source file — a Devanagari six inside a hex colour, a CJK character in a
 * comment, a stray word in a CSS value. Each was invisible on the page it broke
 * and each cost a debugging session, because '#2f4a६8' is not a colour and
 * nothing says so: the style silently does not apply.
 *
 * So: the source is ASCII, except for the typographic and scientific
 * characters actually used in prose and units. A new character here is far more
 * likely to be a slip than a need — if it is a need, add it to the list with
 * a reason.
 */
const ALLOWED = new Set([
  '·', '—', '–', '°', '“', '”', '‘', '’', '×', '→', '←', '✓', '✗', '≈', '…',
  '′', '″', '²', '³', '±', '▸', '▾', '▴',
  'φ', 'λ', 'Δ', 'π',        // the geodesy and astronomy maths
  '©',                       // every attribution string
  '\u00a0',                  // the nbsp entity in the XML entity table
  '\ufeff',                  // the BOM, in the regex that strips it
]);

const ROOTS = ['assets/js', 'assets/css', 'tools'];
const EXTENSIONS = new Set(['.js', '.mjs', '.css']);

async function sourceFiles(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, found);
    else if (EXTENSIONS.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

test('no stray non-ASCII characters in source', async () => {
  const offences = [];

  for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, 'utf8');
      text.split('\n').forEach((line, index) => {
        for (const character of line) {
          if (character.codePointAt(0) > 127 && !ALLOWED.has(character)) {
            offences.push(`${file}:${index + 1} U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} ${character} — ${line.trim().slice(0, 70)}`);
          }
        }
      });
    }
  }

  assert.deepEqual(offences, [], `\n${offences.join('\n')}\n`);
});

/*
 * The same slip, one layer down. `background: #f0b councils;` and
 * `color: #2f4a\u096c8;` are both syntactically fine CSS as far as the parser
 * is concerned — it drops the declaration and says nothing, so the rule simply
 * does not apply and the page looks subtly wrong with no error anywhere.
 *
 * Scoped to declaration values on purpose: `#account` in a selector is an id,
 * not a colour, and an earlier version of this check spent its time reporting
 * those.
 */
test('every hex colour in a CSS value parses as one', async () => {
  const bad = [];

  for (const file of await sourceFiles('assets/css')) {
    const text = await readFile(file, 'utf8');
    // property: value;  — the value side only, so selectors are never scanned.
    for (const declaration of text.matchAll(/(^|[;{])\s*([-a-z]+)\s*:([^;{}]*)[;}]/g)) {
      const [, , property, value] = declaration;
      for (const token of value.matchAll(/#[^\s;,)]*/g)) {
        const hex = token[0].slice(1);
        if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) continue;
        bad.push(`${file}: ${property}: … ${token[0]}`);
      }
    }
  }

  assert.deepEqual(bad, [], `\n${bad.join('\n')}\n`);
});
