/*
 * Ask an ArcGIS feature service what values a field actually takes.
 *
 *   node tools/probe-service.mjs <service-query-url> FIELD [FIELD...]
 *
 * The same question `inspect-archive` answers for a vector tile, asked of the
 * other half of this map. Every layer in config.js filters or colours on some
 * field, and the values are written from documentation, from a sample of one
 * county, or from memory - after which a filter that matches nothing draws an
 * empty layer, which looks exactly like ground with nothing on it.
 *
 * `returnDistinctValues` does the counting on the server, so this is one small
 * request rather than a download of the layer.
 *
 * No dependencies, and no network in the sandbox this is written in, which is
 * why it runs in CI. See .github/workflows/probe-service.yml.
 */

const [target, ...fields] = process.argv.slice(2);

if (!target || !fields.length) {
  console.error('usage: node tools/probe-service.mjs <service url> FIELD [FIELD...]');
  console.error('  e.g. …/Special_Use_Airspace/FeatureServer/0/query TYPE_CODE LOCAL_TYPE');
  process.exit(2);
}

/**
 * Strip whatever query the caller pasted and ask our own question.
 *
 * A URL copied out of config.js carries a bbox, an output format and a record
 * cap, all of which would narrow the answer to whatever was on screen when it
 * was written. The point here is the whole layer.
 */
function distinctQuery(url, names) {
  const at = new URL(url);
  at.search = '';
  at.searchParams.set('where', '1=1');
  at.searchParams.set('outFields', names.join(','));
  at.searchParams.set('returnDistinctValues', 'true');
  at.searchParams.set('returnGeometry', 'false');
  at.searchParams.set('f', 'json');
  return at.href;
}

/**
 * The same question without `returnDistinctValues`, a page at a time.
 *
 * Not every service supports distinct — the FAA's airspace layer answers
 * "Cannot perform query. Invalid query parameters." to it — and a probe that
 * gives up there answers nothing about the layer anybody actually wanted to
 * ask about. Reading rows and counting them here is slower and is bounded by
 * what the service will hand over, which is why the report says which way the
 * answer was reached rather than presenting both as the same fact.
 */
function pageQuery(url, names, offset, size) {
  const at = new URL(url);
  at.search = '';
  at.searchParams.set('where', '1=1');
  at.searchParams.set('outFields', names.join(','));
  at.searchParams.set('returnGeometry', 'false');
  at.searchParams.set('resultOffset', String(offset));
  at.searchParams.set('resultRecordCount', String(size));
  at.searchParams.set('f', 'json');
  return at.href;
}

function countQuery(url, where) {
  const at = new URL(url);
  at.search = '';
  at.searchParams.set('where', where);
  at.searchParams.set('returnCountOnly', 'true');
  at.searchParams.set('f', 'json');
  return at.href;
}

async function ask(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = await response.json();
  // An ArcGIS error is a 200 with an `error` object in it: it parses cleanly
  // and has no rows, which is indistinguishable from a layer that is empty.
  if (body.error) throw new Error(body.error.message || 'service error');
  return body;
}

const escapeSQL = (value) => String(value).replace(/'/g, "''");

console.log(`\n${target}`);
console.log(`  asking for ${fields.join(', ')}\n`);

const PAGE = 2000;
const PAGES = 10;

let combos = [];
let how = 'every distinct combination, counted by the service';
let complete = true;

try {
  const rows = await ask(distinctQuery(target, fields));
  combos = (rows.features || []).map((feature) => feature.attributes || {});
} catch (error) {
  console.log(`  distinct values refused (${error.message}) — reading rows instead\n`);
  how = `read from up to ${(PAGE * PAGES).toLocaleString()} rows`;
  const seen = new Set();
  let offset = 0;
  complete = false;
  for (let page = 0; page < PAGES; page += 1) {
    let body;
    try {
      body = await ask(pageQuery(target, fields, offset, PAGE));
    } catch (inner) {
      console.error(`  the service refused: ${inner.message}`);
      process.exit(1);
    }
    const got = body.features || [];
    for (const feature of got) {
      const row = feature.attributes || {};
      const key = JSON.stringify(fields.map((field) => row[field] ?? null));
      if (!seen.has(key)) { seen.add(key); combos.push(row); }
    }
    // `exceededTransferLimit` is how a service says there is more; its absence
    // on a short page is how it says there is not.
    if (got.length < PAGE && !body.exceededTransferLimit) { complete = true; break; }
    offset += got.length || PAGE;
  }
}

if (!combos.length) {
  console.log('  no rows came back — the service answered, and has nothing to say.');
  process.exit(0);
}

console.log(`  ${combos.length} distinct combination(s) · ${how}`);
if (!complete) {
  console.log('  NOT the whole layer: a value rarer than that cap would not appear here.');
}
console.log('');

for (const field of fields) {
  const seen = new Map();
  for (const row of combos) {
    const value = row[field];
    const key = value === null || value === undefined ? '(null)' : String(value);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  console.log(`  ${field}`);
  for (const [value, times] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`    ${value.padEnd(28)} in ${times} combination(s)`);
  }
  console.log('');
}

/*
 * And how many features each value of the first field actually covers.
 *
 * Distinct values say a code exists; they do not say whether it is one polygon
 * or nine thousand. A filter is worth writing for the second and not the
 * first, and the difference decides whether excluding a code changes anything
 * a reader would see.
 */
const [primary] = fields;
const values = [...new Set(combos.map((row) => row[primary]).filter((one) => one !== null && one !== undefined))];
if (values.length && values.length <= 40) {
  console.log(`  How many features carry each ${primary}?`);
  const total = await ask(countQuery(target, '1=1')).catch(() => null);
  for (const value of values.sort()) {
    try {
      const answer = await ask(countQuery(target, `${primary} = '${escapeSQL(value)}'`));
      const count = answer.count ?? 0;
      const share = total?.count ? ` · ${((count / total.count) * 100).toFixed(1)}% of the layer` : '';
      console.log(`    ${String(value).padEnd(28)} ${String(count).padStart(6)}${share}`);
    } catch (error) {
      console.log(`    ${String(value).padEnd(28)} could not be counted: ${error.message}`);
    }
  }
  if (total?.count) console.log(`    ${'(whole layer)'.padEnd(28)} ${String(total.count).padStart(6)}`);
}
