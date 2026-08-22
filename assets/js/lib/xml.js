/**
 * Minimal dependency-free XML parser.
 *
 * Why not DOMParser? The same parsing code runs in the browser (the map viewer)
 * and in Node (tools/build-catalog.mjs). Rather than shim a DOM on the server or
 * write the extraction logic twice, we parse into a plain object tree that both
 * environments can walk identically.
 *
 * Tree node: { tag, name, attrs, children, text, parent }
 *   tag   - the literal tag as written, e.g. "gpxtpx:TrackPointExtension"
 *   name  - lowercased local name with any namespace prefix stripped, e.g. "trackpointextension"
 *
 * Namespaces are deliberately flattened. GPX and KML in the wild mix prefixes
 * freely (gpx:, gpxx:, gx:, ns2:, none at all) and every lookup we need is
 * unambiguous by local name.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(value) {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return value;
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9._-]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

function localName(tag) {
  const colon = tag.indexOf(':');
  return (colon === -1 ? tag : tag.slice(colon + 1)).toLowerCase();
}

function makeNode(tag, attrs, parent) {
  return { tag, name: localName(tag), attrs, children: [], text: '', parent };
}

/** Index of the '>' that closes the tag starting at `start`, skipping quoted attribute values. */
function findTagEnd(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseAttrs(chunk) {
  const attrs = {};
  if (!chunk || chunk.indexOf('=') === -1) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(chunk)) !== null) {
    const raw = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    attrs[localName(m[1])] = decodeEntities(raw ?? '');
  }
  return attrs;
}

/** Skip a `<!DOCTYPE ...>`, including an internal subset in square brackets. */
function skipDoctype(src, start) {
  const bracket = src.indexOf('[', start);
  const gt = src.indexOf('>', start);
  if (bracket !== -1 && (gt === -1 || bracket < gt)) {
    const close = src.indexOf(']', bracket);
    if (close !== -1) {
      const after = src.indexOf('>', close);
      return after === -1 ? src.length : after + 1;
    }
  }
  return gt === -1 ? src.length : gt + 1;
}

export function parseXML(source) {
  const src = String(source ?? '').replace(/^﻿/, '');
  const root = makeNode('#document', {}, null);
  let node = root;
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      node.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) node.text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      node.text += src.slice(lt + 9, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      i = skipDoctype(src, lt);
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt === -1) break;
    const inner = src.slice(lt + 1, gt);

    if (inner[0] === '/') {
      // Closing tag. Unwind to the matching ancestor so stray/mismatched closers
      // (common in hand-edited exports) cannot detach the whole tree.
      const closing = localName(inner.slice(1).trim());
      let target = node;
      while (target && target !== root && target.name !== closing) target = target.parent;
      node = target && target !== root ? target.parent || root : node;
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const tag = (space === -1 ? body : body.slice(0, space)).trim();
    const child = makeNode(tag, parseAttrs(space === -1 ? '' : body.slice(space)), node);
    node.children.push(child);
    if (!selfClosing) node = child;
    i = gt + 1;
  }

  return root;
}

/* ---------- tree helpers (all match on local name, case-insensitively) ---------- */

export function childrenNamed(node, name) {
  if (!node) return [];
  const want = String(name).toLowerCase();
  return node.children.filter((c) => c.name === want);
}

export function childNamed(node, name) {
  if (!node) return null;
  const want = String(name).toLowerCase();
  return node.children.find((c) => c.name === want) || null;
}

/** First descendant with the given local name, depth-first. */
export function findDescendant(node, name) {
  if (!node) return null;
  const want = String(name).toLowerCase();
  const stack = [...node.children];
  while (stack.length) {
    const cur = stack.shift();
    if (cur.name === want) return cur;
    stack.unshift(...cur.children);
  }
  return null;
}

export function findDescendants(node, name, out = []) {
  if (!node) return out;
  const want = String(name).toLowerCase();
  for (const child of node.children) {
    if (child.name === want) out.push(child);
    findDescendants(child, want, out);
  }
  return out;
}

/** Trimmed text of a node, or '' — never null, so callers can chain freely. */
export function textOf(node) {
  return node ? node.text.trim() : '';
}

/** Trimmed text of a named child. */
export function childText(node, name) {
  return textOf(childNamed(node, name));
}

export function numberOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
