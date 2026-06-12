import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const upstream = String(process.env.LOCAL_PROXY_UPSTREAM || '').trim();
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

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload, null, 2), 'application/json; charset=utf-8');
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname.startsWith('/api/')) {
      if (!upstream) {
        sendJson(res, 503, {
          ok: false,
          local: true,
          code: 'LOCAL_PROXY_DISABLED',
          message: '로컬 API 프록시가 비활성화되어 있습니다. 운영 API 사용량 보호를 위해 LOCAL_PROXY_UPSTREAM 설정이 필요합니다.',
        });
        return;
      }
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
  console.log(
    upstream
      ? `Local API proxy upstream: ${upstream}`
      : 'Local API proxy disabled. Set LOCAL_PROXY_UPSTREAM to enable /api/* forwarding.',
  );
});
