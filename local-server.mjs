import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const upstream = 'https://kbk-theta-accumulation.vercel.app';
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname.startsWith('/api/')) {
      const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
        headers: { accept: req.headers.accept || 'application/json' },
      });
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = normalize(join(root, requestPath));
    if (!filePath.startsWith(root)) {
      send(res, 403, 'Forbidden');
      return;
    }

    try {
      const body = await readFile(filePath);
      send(res, 200, body, contentTypes[extname(filePath)] || 'application/octet-stream');
    } catch (error) {
      const body = await readFile(join(root, 'index.html'));
      send(res, 200, body, contentTypes['.html']);
    }
  } catch (error) {
    send(res, 404, error instanceof Error ? error.message : 'Not found');
  }
}).listen(port, () => {
  console.log(`Local scanner server: http://localhost:${port}`);
});
