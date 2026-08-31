/**
 * Does every field this app reads actually exist on the service it reads it from?
 *
 *   node tools/check-fields.mjs [--json] [--only <id>]
 *
 * `LOCAL_TYPE: { label: 'Type' }` sat in the airspace layer's identify table
 * for as long as that layer has existed. The service has no such column, so
 * the row never rendered — and a row that never renders is indistinguishable
 * from a feature that had nothing to say. It was found by hand, one layer at a
 * time, which is not a way to find the rest.
 *
 * The same shape as the reconciler in `inspect-archive.mjs`: compare what the
 * configuration claims against what the data holds, and report the mismatch.
 * The blind spot both exist for is that every other test in this repo reads
 * the config for both sides of the comparison, so a config naming a column
 * nothing has is entirely self-consistent and passes.
 *
 * Unlike `check-layers.mjs`, this exits non-zero. That tool reports on other
 * people's uptime and must not fail a deploy over it; this one reports on our
 * own claims, and a claim that cannot be true is worth stopping for. A service
 * that will not describe itself is reported and skipped rather than blamed.
 */

import { pathToFileURL } from 'node:url';

import { OVERLAYS } from '../assets/js/config.js';

const args = process.argv.slice(2);
const asJSON = args.includes('--json');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : '';

/**
 * Names the app attaches itself, which no service is expected to carry.
 *
 * A sublayer is tagged as it arrives — `use` says which endpoint answered,
 * and `tag` adds whatever else distinguishes it, which is how a park and a
 * prohibited area live in one layer while still being told apart. Those are
 * ours. Counting them as missing columns would bury the real findings under
 * one false one per layer.
 */
export function injected(layer) {
  const names = new Set(['use']);
  for (const kind of layer.query?.uses || []) {
    for (const key of Object.keys(kind.tag || {})) names.add(key);
  }
  return names;
}

/** Every field name this layer's config says it will read. */
export function declared(layer) {
  const query = layer.query || {};
  const names = new Set();
  for (const name of Object.keys(query.fields || {})) names.add(name);
  if (typeof query.label === 'string') names.add(query.label);
  if (query.fillBy?.field) names.add(query.fillBy.field);
  for (const name of injected(layer)) names.delete(name);
  return [...names];
}

/** The service endpoints behind one layer — one per sublayer, or just the one. */
export function endpoints(layer) {
  const { url = '', uses } = layer.query || {};
  if (!uses) return url ? [{ name: layer.id, url }] : [];
  return uses.map((kind) => ({
    name: kind.layer || kind.use || layer.id,
    url: kind.url || url.replace('{layer}', String(kind.layer)),
  }));
}

/**
 * What a layer says about itself.
 *
 * The query path with its parameters stripped is the layer's own description,
 * which is where the column list lives. Returns null rather than throwing when
 * a service will not answer: an endpoint that cannot be read is a gap in what
 * this check knows, and reporting it as a missing column would be a lie about
 * somebody's configuration.
 */
async function fieldsOf(url) {
  let at;
  try {
    at = new URL(url);
  } catch {
    return null;
  }
  at.pathname = at.pathname.replace(/\/query\/?$/, '');
  at.search = '?f=json';
  try {
    const response = await fetch(at.href, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.json();
    if (body.error || !Array.isArray(body.fields)) return null;
    return body.fields.map((field) => field.name);
  } catch {
    return null;
  }
}

/*
 * Only when run directly. The three functions above are the half that can be
 * checked without a network, and importing a module runs it — so without this
 * guard every test run would try to reach thirty services.
 */
const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!invoked) {
  // The exports above are the point.
} else await main();

async function main() {
const findings = [];

for (const layer of OVERLAYS) {
  if (!layer.query) continue;
  if (only && layer.id !== only) continue;
  const wanted = declared(layer);
  if (!wanted.length) continue;

  const places = endpoints(layer);
  if (!places.length) continue;

  const held = new Set();
  const unreadable = [];
  for (const place of places) {
    const names = await fieldsOf(place.url);
    if (!names) { unreadable.push(place.name); continue; }
    for (const name of names) held.add(name);
  }

  /*
   * Absent from *every* sublayer, not from one.
   *
   * WKHR_CODE is not on the special-use airspace service and is on the
   * national-defence one, and both are sublayers of the same map layer. A
   * check that asked each endpoint separately would have called it dead and
   * sent somebody deleting a row that works.
   */
  const missing = wanted.filter((name) => !held.has(name));
  findings.push({
    id: layer.id,
    name: layer.name,
    declared: wanted.length,
    missing,
    unreadable,
    // Nothing could be read, so nothing can be concluded.
    blind: unreadable.length === places.length,
  });
}

if (asJSON) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  console.log('\nFields the config reads, against the services that hold them\n');
  for (const found of findings) {
    const label = `${found.id}`.padEnd(22);
    if (found.blind) {
      console.log(`  ?  ${label} no endpoint would describe itself — nothing checked`);
      continue;
    }
    if (!found.missing.length) {
      console.log(`  ok ${label} all ${found.declared} present`);
    } else {
      console.log(`  !! ${label} ${found.missing.length} of ${found.declared} do not exist: ${found.missing.join(', ')}`);
    }
    if (found.unreadable.length) {
      console.log(`     ${' '.repeat(22)} (could not read: ${found.unreadable.join(', ')})`);
    }
  }

  const bad = findings.filter((found) => !found.blind && found.missing.length);
  const blind = findings.filter((found) => found.blind);
  console.log('');
  if (blind.length) console.log(`${blind.length} layer(s) could not be checked at all.`);
  if (!bad.length) {
    console.log('Every field the config reads exists on the service it reads it from.');
  } else {
    console.log(`${bad.length} layer(s) read a column that is not there. Those rows can never render.`);
  }
}

// Non-zero, unlike check-layers: this is about our own claims, not somebody
// else's uptime. A layer nothing could be read from does not fail it.
process.exit(findings.some((found) => !found.blind && found.missing.length) ? 1 : 0);
}
