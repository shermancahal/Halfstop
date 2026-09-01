import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const [, , port, root] = process.argv;
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    const data = await readFile(path.join(path.resolve(root), u.pathname));
    res.writeHead(200, { 'content-type': T[path.extname(u.pathname)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404).end('no'); }
}).listen(Number(port));
