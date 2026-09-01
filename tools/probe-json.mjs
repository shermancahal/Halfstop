/**
 * Ask a JSON service what shape its answer is.
 *
 *   node tools/probe-json.mjs <url> [--depth 4] [--post '<body>']
 *
 * check-layers answers "did this endpoint reply the way we expected", which is
 * the right question once you know what to expect. This answers the one before
 * it: what is actually in there? A regex that matches proves the key exists; a
 * regex that misses proves nothing at all - it cannot tell "the field is absent"
 * from "I guessed the name wrong", and this repo has spent real time on that
 * difference.
 *
 * Prints the structure rather than the body. A routing response is fourteen
 * kilobytes of coordinates and the useful part is the dozen key names holding
 * them, so arrays report their length and one sample, long strings report their
 * length and a prefix, and everything is capped by depth.
 */

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

if (!url) {
  console.error('Usage: node tools/probe-json.mjs <url> [--depth 4] [--post \'{"a":1}\']');
  process.exit(2);
}

const maxDepth = Number(flag('depth', 4));
const post = flag('post', null);

/** One line per node: its path, its type, and just enough of its value. */
function describe(node, path = '', depth = 0, out = []) {
  const at = path || '(root)';
  if (node === null) { out.push(`${at}  null`); return out; }

  if (Array.isArray(node)) {
    out.push(`${at}  array[${node.length}]`);
    // One sample, because a hundred identical shapes tell you nothing a single
    // one does not - and the first is the one a reader can check by hand.
    if (node.length && depth < maxDepth) describe(node[0], `${at}[0]`, depth + 1, out);
    return out;
  }

  if (typeof node === 'object') {
    if (depth >= maxDepth) { out.push(`${at}  object{${Object.keys(node).join(', ')}}`); return out; }
    for (const [key, value] of Object.entries(node)) {
      describe(value, path ? `${path}.${key}` : key, depth + 1, out);
    }
    return out;
  }

  if (typeof node === 'string') {
    const shown = node.length > 48 ? `${JSON.stringify(node.slice(0, 48))}… (${node.length} chars)` : JSON.stringify(node);
    out.push(`${at}  string ${shown}`);
    return out;
  }
  out.push(`${at}  ${typeof node} ${node}`);
  return out;
}

const response = await fetch(url, post
  ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: post }
  : {});

console.log(`${response.status} ${response.statusText}  ${response.headers.get('content-type') || ''}`);
console.log(`access-control-allow-origin: ${response.headers.get('access-control-allow-origin') || '(none)'}`);

const text = await response.text();
console.log(`${text.length} bytes\n`);

try {
  for (const line of describe(JSON.parse(text))) console.log(`  ${line}`);
} catch (error) {
  console.log(`Not JSON (${error.message}). First 400 characters:\n`);
  console.log(text.slice(0, 400));
}
