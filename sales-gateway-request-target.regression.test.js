'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

// HTTP/1.1 permits absolute-form and network-path request targets. A proxy
// endpoint must not mistake "http://host/sales" for an ordinary unprotected
// path and forward the original target to a legacy CRM server.
test('absolute-form and network-path targets cannot bypass protected Sales/Bitrix routes', async t => {
  const forwarded = [];
  const upstream = http.createServer((req, res) => {
    forwarded.push({ method: req.method, target: req.url });
    res.writeHead(200);
    res.end('legacy received request');
  });
  const listen = server => new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
  const close = server => new Promise(resolve => server.close(resolve));
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({
    upstreamPort,
    dashboardToken: 'test-only-dashboard-token',
    bitrixToken: 'test-only-bitrix-token',
    salesModule: {
      html: () => '<p>Sales test</p>',
      status: () => ({ ok: true }),
      handleEvent: async () => null,
    },
  });
  const port = await listen(gateway);
  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });

  const request = (method, path) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

  for (const [method, target] of [
    ['GET', 'http://localhost/sales'],
    ['GET', 'http://localhost/sales/status'],
    ['POST', 'http://localhost/bitrix/events'],
    ['POST', '//localhost/bitrix/events'],
    ['GET', '//localhost/sales/status'],
  ]) {
    assert.equal(await request(method, target), 400,
      method + ' ' + target + ' must reject an ambiguous HTTP target');
  }
  assert.deepEqual(forwarded, [],
    'no non-origin-form request target may be sent to a legacy CRM upstream');

  assert.equal(await request('GET', '/legacy/health'), 200,
    'an ordinary unrelated origin-form legacy route remains supported');
  assert.deepEqual(forwarded, [{ method: 'GET', target: '/legacy/health' }]);
});
