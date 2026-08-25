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

/*
 * The stray-word variant, which the two checks above cannot see.
 *
 * `color: #c4a straight;` and `background: #f0b councils;` are both a valid
 * colour with a word stuck to it. The hex parses, so the hex check passes; the
 * word is ASCII, so the character check passes; and CSS quietly drops the whole
 * declaration, so the rule never applies and nothing says why. Both of those
 * are real lines that were written here.
 *
 * Single-valued colour properties are the tight case: `color` takes one value
 * and one value only, so a second token in one is always a mistake. Shorthands
 * like `background` legitimately take several and are left alone.
 */
test('single-valued colour properties carry exactly one value', async () => {
  const SINGLE = new Set([
    'color', 'background-color', 'border-color', 'border-top-color',
    'border-right-color', 'border-bottom-color', 'border-left-color',
    'outline-color', 'fill', 'stroke', 'caret-color', 'text-decoration-color',
    'column-rule-color', 'accent-color',
  ]);

  const bad = [];
  for (const file of await sourceFiles('assets/css')) {
    const text = await readFile(file, 'utf8');
    for (const declaration of text.matchAll(/(?:^|[;{])\s*([-a-z]+)\s*:([^;{}]*)[;}]/g)) {
      const [, property, rawValue] = declaration;
      if (!SINGLE.has(property)) continue;

      // Collapse functions to a single token before counting. Repeatedly,
      // because `var(--a, var(--b))` nests, and drop `!important` — both are
      // ordinary and neither is a second value.
      let value = rawValue.replace(/!\s*important/gi, ' ');
      for (let pass = 0; pass < 5; pass += 1) {
        const collapsed = value.replace(/[a-z-]+\([^()]*\)/gi, 'fn');
        if (collapsed === value) break;
        value = collapsed;
      }

      if (value.trim().split(/\s+/).filter(Boolean).length > 1) {
        bad.push(`${file}: ${property}: ${rawValue.trim()}`);
      }
    }
  }

  assert.deepEqual(bad, [], `\n${bad.join('\n')}\n`);
});

/*
 * Exactly one workflow may publish the site.
 *
 * There were two. Both ran on every push, both went green, and the second
 * finished about thirteen seconds after the first — so it overwrote every good
 * deploy with a build of the repository root: no token.js (gitignored, so never
 * in the repo), no build stamp, no cache-busted filenames. The site worked well
 * enough to hide it, and the only visible symptom was a 404 on two files.
 *
 * Nothing about that was detectable from inside the app, and both workflows
 * reported success, so the check has to live here.
 */
test('only one workflow deploys to Pages', async () => {
  const dir = '.github/workflows';
  const publishers = [];

  for (const name of await readdir(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = await readFile(path.join(dir, name), 'utf8');
    if (/actions\/deploy-pages@/.test(text)) publishers.push(name);
  }

  assert.deepEqual(publishers, ['deploy-pages.yml'],
    `these all publish to Pages and will race each other: ${publishers.join(', ')}`);
});

test('the published artifact is the built site, not the repository', async () => {
  // `path: .` uploads the working tree — which looks almost right, and is
  // missing every generated file.
  const text = await readFile('.github/workflows/deploy-pages.yml', 'utf8');
  const uploads = [...text.matchAll(/upload-pages-artifact@v\d[\s\S]{0,120}?path:\s*(\S+)/g)]
    .map((match) => match[1]);

  assert.deepEqual(uploads, ['./dist'], 'Pages must publish ./dist');
});
