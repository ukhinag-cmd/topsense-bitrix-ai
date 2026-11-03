'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

const token = 'read-only-route-guard-test';
const authorization = 'Basic ' + Buffer.from('sales:' + token).toString('base64');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
function request(port, path, headers = { authorization }) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

// The two supported Sales GET routes are deliberately local and read-only.
// An unknown /sales/* path must not reach an explicitly configured legacy
// upstream, where GET endpoints might expose unrelated data or have side effects.
test('authenticated unknown Sales GET routes never fall through to legacy upstream', async t => {
  const forwarded = [];
  const upstream = http.createServer((req, res) => {
    forwarded.push(req.url);
    res.writeHead(200);
    res.end('legacy response');
  });
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({
    upstreamPort,
    dashboardToken: token,
    bitrixToken: 'test-only-bitrix-token',
    salesModule: {
      html: () => '<h1>Sales</h1>',
      status: () => ({ ok: true }),
      handleEvent: async () => null,
    },
  });
  const port = await listen(gateway);
  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });

  for (const path of ['/sales/export', '/sales/status/more', '/sales/legacy?download=1']) {
    const response = await request(port, path);
    assert.equal(response.status, 404, path + ' should be local-only');
    assert.equal(response.headers['cache-control'], 'no-store', path);
  }
  assert.deepEqual(forwarded, [], 'Sales requests must never fall through to legacy upstream');

  assert.equal((await request(port, '/sales')).status, 200);
  assert.equal((await request(port, '/sales/status')).status, 200);
  assert.equal((await request(port, '/sales/export', {})).status, 401);
  assert.deepEqual(forwarded, []);
});
