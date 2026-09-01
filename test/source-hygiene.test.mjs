import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

test('both workflows cut the map archive with the same script', async () => {
  /*
   * Two workflows need a Protomaps extract and they need it identically: the
   * deploy publishes one with the site, and cut-archive.yml hands one back to
   * put on a bucket. Forty lines of shell copied between them is forty lines
   * to fix twice, and the half that gets missed is whichever one is not being
   * looked at when the next thing about it turns out to be wrong.
   *
   * Three values in that script are discovered at run time rather than written
   * down — the pmtiles release asset, the planet build, the archive's real
   * depth — and every one of them has already been guessed wrong once. That is
   * exactly the knowledge that must not exist in two places.
   */
  const dir = '.github/workflows';
  const cutting = [];
  const calling = [];

  for (const name of await readdir(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = await readFile(path.join(dir, name), 'utf8');
    if (/pmtiles extract|go-pmtiles\/releases/.test(text)) cutting.push(name);
    if (/tools\/cut-archive\.sh/.test(text)) calling.push(name);
  }

  assert.deepEqual(cutting, [],
    `these cut an archive inline instead of calling tools/cut-archive.sh: ${cutting.join(', ')}`);
  assert.deepEqual(calling.sort(), ['cut-archive.yml', 'deploy-pages.yml']);
});

test('only one file composes an archive tile key', async () => {
  /*
   * The offline round-trip test in test/pmtiles.test.mjs cannot catch this,
   * and it is worth saying why: now that both sides call `tileKey`, changing
   * the format changes both together and the test passes — correctly, because
   * that is no longer a bug. The bug is somebody writing the template out
   * again, at which point the two sides can drift by one character.
   *
   * And that failure is the quietest one this app has. The download reports
   * every tile saved, the phone fills up, and the map is blank the moment the
   * signal goes — with no error anywhere, because a tile the store does not
   * hold is a legitimate answer that falls through to a network read that
   * cannot happen.
   */
  const composing = [];
  for (const root of ['assets/js', 'assets/js/lib', 'tools']) {
    for (const name of await readdir(root, { withFileTypes: true })) {
      if (!name.isFile() || !/\.m?js$/.test(name.name)) continue;
      const rel = path.join(root, name.name);
      if (rel.endsWith('pmtiles-store.js')) continue;
      const text = await readFile(rel, 'utf8');
      // The shape of the key: something, a separator, then z/x/y.
      if (/\$\{[a-zA-Z.]+\}[|#/]\$\{z\}\/\$\{x\}\/\$\{y\}/.test(text)) composing.push(rel);
    }
  }
  assert.deepEqual(composing, [],
    'these build an archive tile key themselves; it must come from tileKey()');
});

test('the bucket credentials never reach a workflow that writes the site', async () => {
  /*
   * An R2 API token can write to the bucket. It is the one genuinely secret
   * value this project has - the Mapbox key is public by design and the
   * archive URL is a public URL - and there is exactly one workflow that
   * should ever see it.
   *
   * The risk is specific rather than theoretical. deploy-pages.yml reads
   * secrets and writes them into assets/js/token.js, which is served to every
   * visitor. That is correct for the two values that belong in a browser and
   * catastrophic for a key that can write to a bucket, and the difference
   * between the two is one line of YAML written by somebody in a hurry.
   *
   * So the rule is by name: only the workflow that uploads may mention them.
   */
  const dir = '.github/workflows';
  const ALLOWED = 'cut-archive.yml';
  const offenders = [];
  for (const name of await readdir(dir)) {
    if (!/\.ya?ml$/.test(name) || name === ALLOWED) continue;
    const text = await readFile(path.join(dir, name), 'utf8');
    for (const secret of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID']) {
      if (text.includes(secret)) offenders.push(`${name} mentions ${secret}`);
    }
  }
  assert.deepEqual(offenders, [],
    `only ${ALLOWED} may reference the bucket credentials`);
});

test('nothing writes a bucket credential into the client config', async () => {
  /*
   * The other half, and the one that would actually publish it: whatever
   * builds assets/js/token.js must only put things in it that a browser is
   * meant to have. Checked against the file that writes it rather than against
   * a list of secrets, so a new credential added later is covered without
   * anybody remembering to add it here.
   */
  const deploy = await readFile('.github/workflows/deploy-pages.yml', 'utf8');
  const block = deploy.slice(deploy.indexOf('Write the client config'));
  const written = [...block.matchAll(/window\.(ABMAP_[A-Z_]+)\s*=/g)].map((m) => m[1]);
  assert.deepEqual(written.sort(), [
    'ABMAP_MAPBOX_TOKEN',
    'ABMAP_PROTOMAPS_ARCHIVE',
    'ABMAP_PROTOMAPS_MAXZOOM',
    // The routing endpoint. A public URL, like the archive - it is here so that
    // moving routing off FOSSGIS's shared demo server and onto your own
    // Valhalla is a repository variable rather than a code change, which their
    // terms ask for and a paid tier will require.
    'ABMAP_ROUTING_URL',
    'ABMAP_SUPABASE_KEY',
    'ABMAP_SUPABASE_URL',
  ], 'the client config gained or lost a value; every one of these is served to every visitor');
});

test('no reverse-geocode URL combines a limit with several types', async () => {
  /*
   * Mapbox answers that combination with a 422 and this message:
   *
   *   limit must be combined with a single type parameter when reverse geocoding
   *
   * The app shipped exactly that for months. Nothing caught it because a failed
   * lookup is indistinguishable from one that has not answered yet — the place
   * name is simply absent — and because the probe written to check the geocoder
   * used a single type, a legal URL the app never sends.
   *
   * A source-level guard rather than a behavioural one, because the failure is
   * in the request and no amount of testing the response can see it.
   */
  const raw = await readFile(path.join('assets', 'js', 'lib', 'place.js'), 'utf8');

  /*
   * Join concatenated template literals before matching.
   *
   * The first version of this test did not, and passed against the broken URL
   * it was written to catch — the query string lives in the second half of a
   * `` `...` + `...` `` pair, so a pattern anchored on the hostname only ever
   * saw the half with no parameters in it. A guard that cannot fail is worse
   * than none: it reads as coverage.
   */
  const source = raw.replace(/`\s*\+\s*`/g, '');

  for (const [url] of source.matchAll(/`https:\/\/api\.mapbox\.com\/geocoding[^`]*`/g)) {
    const types = /[?&]types=([^&`$]*)/.exec(url)?.[1] || '';
    const hasLimit = /[?&]limit=/.test(url);
    assert.ok(
      !(hasLimit && types.includes(',')),
      `this URL asks for several types alongside a limit, which Mapbox rejects: ${url}`,
    );
  }
});

test('every docs/ reference in the source points at a file that exists', async () => {
  /*
   * Written after doing exactly this.
   *
   * Two files were shipped saying "See docs/routing.md" and docs/routing.md did
   * not exist. Nothing breaks - it is a comment - which is the problem: the
   * pointer reads as authoritative right up until somebody follows it, and the
   * person who follows it is the one who most needed the page.
   */
  const roots = ['assets', 'docs', 'tools', '.github'];
  const dangling = [];

  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(js|mjs|md|yml|yaml|html)$/.test(entry.name)) continue;
      const text = await readFile(full, 'utf8');
      for (const ref of text.match(/docs\/[\w.-]+\.md/g) || []) {
        if (!existsSync(ref)) dangling.push(`${full} points at ${ref}`);
      }
    }
  };
  for (const root of roots) await walk(root);
  const readme = await readFile('README.md', 'utf8');
  for (const ref of readme.match(/docs\/[\w.-]+\.md/g) || []) {
    if (!existsSync(ref)) dangling.push(`README.md points at ${ref}`);
  }

  assert.deepEqual(dangling, [], 'a comment sends the reader to a page that is not there');
});
