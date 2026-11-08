'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

const listen = server => new Promise(resolve =>
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
);
const close = server => new Promise(resolve => server.close(resolve));

test('dot-segment paths cannot escape the protected Sales/Bitrix namespace into legacy upstream', async t => {
  const forwarded = [];
  const upstream = http.createServer((req, res) => {
    forwarded.push({ method: req.method, path: req.url });
    res.writeHead(200);
    res.end('legacy');
  });
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({
    upstreamPort,
    dashboardToken: 'mock-sales-secret',
    bitrixToken: 'mock-bitrix-secret',
    salesModule: {
      html: () => '<p>read-only</p>',
      status: () => ({ ok: true }),
      handleEvent: async () => null,
    },
  });
  const port = await listen(gateway);
  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });

  const send = (method, path) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

  // The URL parser normalizes literal, once-encoded and multiply-encoded
  // ".." segments. Without a pre-normalization guard, a path that starts
  // in a protected namespace becomes an unrelated, proxied legacy route.
  for (const [method, path] of [
    ['GET', '/sales/../legacy/health'],
    ['GET', '/sales/%2e%2e/legacy/health'],
    ['GET', '/sales/%252e%252e/legacy/health'],
    ['GET', '/bitrix/events/../legacy/health'],
    ['POST', '/bitrix/events/%2E%2e/legacy/health'],
  ]) {
    assert.equal(await send(method, path), 400,
      method + ' ' + path + ' must not be forwarded via dot-segment normalization');
  }
  assert.deepEqual(forwarded, [], 'no dot-segment escape may reach a legacy CRM server');

  assert.equal(await send('GET', '/legacy/health'), 200,
    'unrelated canonical legacy paths remain available to an explicitly configured upstream');
  assert.deepEqual(forwarded, [{ method: 'GET', path: '/legacy/health' }]);
});
