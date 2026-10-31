'use strict';

const http = require('http');
const {
  MAX_EVENT_BODY,
  decodeBasicCredentials,
  parseBitrixEvent,
  sanitizeProxyHeaders,
} = require('./sales-gateway-helpers');

const PUBLIC_PORT = Number(process.env.PORT || 10000);

function dashboardAuthorized(req, expectedToken) {
  if (!expectedToken) return false;
  const credentials = decodeBasicCredentials(req.headers.authorization);
  if (!credentials || credentials.username !== 'sales') return false;
  const supplied = Buffer.from(credentials.password, 'utf8');
  const actual = Buffer.from(String(expectedToken), 'utf8');
  const { timingSafeEqual } = require('crypto');
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

function canonicalRequestPath(rawPath) {
  let decoded = String(rawPath || '/');
  for (let depth = 0; depth < 8; depth += 1) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { return null; }
    if (next === decoded) break;
    decoded = next;
    if (depth === 7) {
      try { if (decodeURIComponent(decoded) !== decoded) return null; } catch { return null; }
    }
  }
  // Encoded query/fragment delimiters make route interpretation ambiguous.
  if (decoded.includes('?') || decoded.includes('#')) return null;
  decoded = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  try {
    decoded = new URL('http://localhost' + (decoded.startsWith('/') ? decoded : '/' + decoded)).pathname;
  } catch { return null; }
  return decoded.replace(/\/+$/, '') || '/';
}

function isProtectedPath(pathname) {
  const withoutMatrixParams = pathname.split('/').map(segment => segment.split(';', 1)[0]).join('/');
  const lower = withoutMatrixParams.toLowerCase();
  return lower === '/sales' || lower.startsWith('/sales/') || lower === '/bitrix/events';
}

function createGateway({
  upstreamPort = null,
  dashboardToken = String(process.env.SALES_DASHBOARD_TOKEN || ''),
  bitrixToken = String(process.env.BITRIX_OUTBOUND_TOKEN || ''),
  salesModule,
} = {}) {
  const salesApi = salesModule || require('./sales');
  return http.createServer((req, res) => {
    const rawPath = String(req.url || '/').split('?', 1)[0] || '/';
    const pathname = canonicalRequestPath(rawPath);
    if (!pathname) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Invalid or ambiguous request path');
    }
    const rawPathNormalized = rawPath.replace(/\/+$/, '') || '/';
    const protectedPath = pathname.split('/').map(segment => segment.split(';', 1)[0]).join('/');
    if (isProtectedPath(pathname) &&
        (rawPathNormalized !== pathname || pathname !== protectedPath.toLowerCase())) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Non-canonical protected route');
    }

    if (pathname === '/sales' || pathname.startsWith('/sales/')) {
      if (!dashboardToken) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Dashboard is not configured');
      }
      if (!dashboardAuthorized(req, dashboardToken)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="TOP-SENS Sales", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Authentication required');
      }
    }

    // Never proxy writes or unknown methods under the read-only dashboard.
    if ((pathname === '/sales' || pathname.startsWith('/sales/')) && req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
      return res.end('Method not allowed');
    }

    if (req.method === 'GET' && pathname === '/sales') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(salesApi.html());
    }

    if (req.method === 'GET' && pathname === '/sales/status') {
      const body = JSON.stringify(salesApi.status());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      return res.end(body);
    }

    function forward(bodyBuffer) {
      // The Sales process is isolated by default: no legacy server is started.
      // Only tests or an explicitly constructed gateway may provide upstreamPort.
      if (!upstreamPort) {
        res.writeHead(404, { 'cache-control': 'no-store' });
        return res.end('Route unavailable in read-only Sales gateway');
      }
      const headers = sanitizeProxyHeaders(req.headers, dashboardToken);
      if (bodyBuffer) {
        delete headers['transfer-encoding'];
        headers['content-length'] = String(bodyBuffer.length);
      }
      const proxy = http.request({
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      }, upstream => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      });

      proxy.on('error', error => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'upstream unavailable' }));
        console.error(JSON.stringify({
          source: 'sales-mvp', action: 'gateway-error', error: error.message,
        }));
      });

      if (bodyBuffer) proxy.end(bodyBuffer);
      else req.pipe(proxy);
    }

    // Never let the existing handler accept events when its shared token is
    // absent; server.js intentionally preserves its legacy optional-token mode.
    if (req.method === 'POST' && pathname === '/bitrix/events' && req.url !== '/bitrix/events') {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end('Non-canonical Bitrix event route');
    }
    if (req.method === 'POST' && pathname === '/bitrix/events') {
      if (!bitrixToken) {
        req.resume();
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Bitrix event validation is not configured');
      }
      const chunks = [];
      let size = 0;
      let rejected = false;
      req.on('data', chunk => {
        if (rejected) return;
        size += chunk.length;
        if (size > MAX_EVENT_BODY) {
          rejected = true;
          chunks.length = 0;
          res.writeHead(413, { 'cache-control': 'no-store' });
          res.end('payload too large');
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        const body = Buffer.concat(chunks, size);
        const event = parseBitrixEvent(body, req.headers['content-type'], bitrixToken);
        if (!event) {
          res.writeHead(401, { 'cache-control': 'no-store' });
          return res.end('Invalid or unsupported Bitrix event');
        }

        // Acknowledged authenticated events are processed by the read-only
        // Sales module only. NEVER pass events to the legacy server.js, whose
        // activity/deal handlers may create or modify Bitrix CRM records.
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, event: event.event, dealId: event.dealId, activityId: event.activityId }));
        Promise.resolve().then(() => salesApi.handleEvent(event)).catch(error => {
          console.warn(JSON.stringify({
            source: 'sales-mvp', action: 'event-processing-failed',
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      });
      return;
    }

    forward(null);
  });
}

function start() {
  const sales = require('./sales');
  sales.start().catch(error => {
    console.error(JSON.stringify({
      source: 'sales-mvp', action: 'startup-error',
      error: error instanceof Error ? error.message : String(error),
    }));
  });

  const gateway = createGateway({ salesModule: sales });
  gateway.listen(PUBLIC_PORT, '0.0.0.0', () => {
    console.log('TOP-SENSE Sales gateway listening on port ' + PUBLIC_PORT);
  });

  process.on('SIGTERM', () => gateway.close());
  return { gateway, child: null };
}

if (require.main === module) start();

module.exports = Object.freeze({ createGateway, dashboardAuthorized, start });
