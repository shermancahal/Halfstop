#!/usr/bin/env node
/**
 * Minimal static server for local development.
 *
 * The site uses ES modules and fetch(), so opening index.html over file:// does
 * not work — this exists purely so `npm start` gives you a working origin.
 * It is a development tool and is not part of what gets deployed.
 *
 * Usage:  node tools/serve.mjs [port]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.kml': 'application/vnd.google-earth.kml+xml; charset=utf-8',
  '.kmz': 'application/vnd.google-earth.kmz',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.join(ROOT, pathname);
  // Refuse anything that escapes the project root.
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      response.writeHead(302, { Location: `${pathname.replace(/\/$/, '')}/` }).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<h1>404</h1><p>No file at <code>${pathname.replace(/[<>&]/g, '')}</code></p>`);
  }
});

server.listen(PORT, () => {
  console.log(`Fieldstop — serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/          landing page`);
  console.log(`  http://localhost:${PORT}/map.html  viewer`);
});
