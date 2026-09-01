import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * A name used but never imported is a runtime error, and only on the one path
 * that reaches it.
 *
 * `drawTripRoute` folded the route's bounds with `extendBounds`, starting from
 * `emptyBounds()`. Both are real functions, both exported by lib/geo.js, and
 * neither was in viewer.js's import list. Nothing failed at load: the module
 * parsed, the app started, every test passed, and the error arrived only when
 * somebody pressed the button — "emptyBounds is not defined", the route never
 * drawn, and a toast the only sign of it.
 *
 * A parse check cannot catch that and neither can loading the page. What can is
 * asking, for each library module, whether a page calls a name it exports
 * without importing it.
 */

const PAGES = ['assets/js/viewer.js', 'assets/js/home.js', 'assets/js/faq.js'];

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

/** Every name a module exports, however it says so. */
function exportsOf(source) {
  const names = new Set();
  for (const [, name] of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(name);
  for (const [, name] of source.matchAll(/^export\s+(?:const|let|class)\s+(\w+)/gm)) names.add(name);
  for (const [, block] of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of block.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Every name a page pulls in, under whatever local name it binds them to. */
function importedBy(source) {
  const names = new Set();
  for (const [, block] of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'[^']*'/g)) {
    for (const part of block.split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop().trim();
      if (local) names.add(local);
    }
  }
  for (const [, name] of source.matchAll(/import\s+(\w+)\s+from/g)) names.add(name);
  return names;
}

/**
 * Where a page binds a name of its own, so a local one is not read as a miss.
 *
 * Over-collecting here costs sensitivity and never adds noise, which is the
 * right way round for a check that must not cry wolf.
 */
function declaredBy(source) {
  const names = new Set();
  for (const [, name] of source.matchAll(/(?:^|\s)(?:async\s+)?function\s+(\w+)/gm)) names.add(name);
  for (const [, name] of source.matchAll(/(?:^|\s)(?:const|let|var|class)\s+(\w+)/gm)) names.add(name);
  for (const [, block] of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of block.split(',')) {
      const local = part.trim().split(/[:=]/).pop().trim();
      if (/^\w+$/.test(local)) names.add(local);
    }
  }
  return names;
}

test('pages: no page calls a library export it forgot to import', async () => {
  const libDir = new URL('../assets/js/lib/', import.meta.url);
  const libs = (await readdir(libDir)).filter((name) => name.endsWith('.js'));

  const exported = new Map();
  for (const name of libs) {
    for (const symbol of exportsOf(await read(`assets/js/lib/${name}`))) {
      if (!exported.has(symbol)) exported.set(symbol, name);
    }
  }

  const missing = [];
  for (const page of PAGES) {
    let source;
    try {
      source = await read(page);
    } catch {
      continue;
    }
    const imported = importedBy(source);
    const declared = declaredBy(source);
    const body = source.replace(/import[\s\S]*?from\s*'[^']*';/g, '');

    for (const [symbol, from] of exported) {
      if (imported.has(symbol) || declared.has(symbol)) continue;
      // Called as a bare identifier, not reached through an object.
      if (new RegExp(`(^|[^.\\w'"\`])${symbol}\\s*\\(`, 'm').test(body)) {
        missing.push(`${path.basename(page)} calls ${symbol}() from lib/${from} without importing it`);
      }
    }
  }

  assert.deepEqual(missing.sort(), [],
    'these throw at runtime, on whichever path happens to reach them');
});
