import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 补全排序：精确 > 前缀 > 包含 > 说明里包含；常用变量靠前。 */
export function searchVariables(catalog, query, limit = 30) {
  const q = String(query || '').trim().toUpperCase();
  if (!q) {
    return catalog
      .slice()
      .sort((a, b) => Number(b.hot) - Number(a.hot) || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  const scored = [];
  for (const v of catalog) {
    const name = v.name.toUpperCase();
    let score = -1;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if ((v.summary || '').toUpperCase().includes(q)) score = 3;
    if (score < 0) continue;
    scored.push({ v, score });
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.v.hot) - Number(a.v.hot) ||
      a.v.name.length - b.v.name.length ||
      a.v.name.localeCompare(b.v.name)
  );
  return scored.slice(0, limit).map((s) => s.v);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/**
 * 起一个只监听本机的补全 API + 验证页面。
 * @param {{catalog: object[], meta: object, port?: number, host?: string}} opts
 */
export function startServer(opts) {
  const catalog = opts.catalog || [];
  const meta = opts.meta || {};
  const host = opts.host || '127.0.0.1';
  const pagePath = path.join(__dirname, '..', 'public', 'index.html');

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://' + host);
    } catch {
      return sendJson(res, 400, { error: 'bad-request' });
    }

    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 30);
      const items = searchVariables(catalog, q, limit);
      return sendJson(res, 200, { query: q, total: items.length, items });
    }

    if (url.pathname === '/api/stats') {
      const byType = {};
      for (const v of catalog) {
        const t = v.type || 'unknown';
        byType[t] = (byType[t] || 0) + 1;
      }
      return sendJson(res, 200, { meta, count: catalog.length, byType });
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, count: catalog.length });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html = '';
      try {
        html = fs.readFileSync(pagePath, 'utf8');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('页面模板缺失: ' + err.message);
      }
      html = html.replace('__COUNT__', String(catalog.length));
      html = html.replace('__VERSION__', String((meta.cmake && meta.cmake.version) || '?'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    sendJson(res, 404, { error: 'not-found' });
  });

  const started = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port === undefined ? 4848 : opts.port, host, () => resolve(server.address()));
  });

  return { server, started };
}
