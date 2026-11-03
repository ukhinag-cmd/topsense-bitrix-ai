'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

function request(port, path, authorized = true) {
  const headers = authorized
    ? { authorization: 'Basic ' + Buffer.from('sales:header-test-token').toString('base64') }
    : {};
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

test('read-only Sales HTML and JSON refuse framing, MIME sniffing and referrer disclosure', async t => {
  const gateway = createGateway({
    dashboardToken: 'header-test-token',
    bitrixToken: 'event-test-token',
    salesModule: {
      html: () => '<!doctype html><style>body{color:white}</style><h1>Sales</h1>',
      status: () => ({ ok: true }),
      handleEvent: async () => {},
    },
  });
  const port = await new Promise(resolve =>
    gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port))
  );
  t.after(() => new Promise(resolve => gateway.close(resolve)));

  for (const path of ['/sales', '/sales/status']) {
    for (const authorized of [true, false]) {
      const response = await request(port, path, authorized);
      assert.equal(response.status, authorized ? 200 : 401, path);
      assert.equal(response.headers['cache-control'], 'no-store', path);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(response.headers['x-frame-options'], 'DENY', path);
      assert.equal(response.headers['referrer-policy'], 'no-referrer', path);
      const csp = response.headers['content-security-policy'];
      assert.match(csp || '', /(?:^|;)\s*default-src 'none'/);
      assert.match(csp || '', /(?:^|;)\s*style-src 'unsafe-inline'/);
      assert.match(csp || '', /(?:^|;)\s*frame-ancestors 'none'/);
      assert.match(csp || '', /(?:^|;)\s*base-uri 'none'/);
      assert.match(csp || '', /(?:^|;)\s*form-action 'none'/);
    }
  }
});
