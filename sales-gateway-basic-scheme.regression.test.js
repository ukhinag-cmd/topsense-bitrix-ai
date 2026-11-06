'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sanitizeProxyHeaders } = require('./sales-gateway-helpers');
const { createGateway } = require('./sales-gateway');

const dashboardToken = 'local-sales-token-for-regression';
const basic = (scheme, user, password) =>
  scheme + ' ' + Buffer.from(user + ':' + password).toString('base64');

test('case-insensitive HTTP Basic scheme cannot leak Sales credentials through a proxy', () => {
  for (const scheme of ['basic', 'BASIC', 'bAsIc']) {
    const salesHeader = basic(scheme, 'sales', dashboardToken);
    for (const value of [salesHeader, '  ' + salesHeader + ' ']) {
      const headers = sanitizeProxyHeaders({ Authorization: value, 'x-trace': 'preserved' }, dashboardToken);
      assert.equal(Object.keys(headers).some(key => key.toLowerCase() === 'authorization'), false,
        'Sales Basic credentials must be removed even with alternate scheme capitalization');
      assert.equal(headers['x-trace'], 'preserved');
    }
    const unrelated = basic(scheme, 'unrelated', 'own-secret');
    assert.equal(sanitizeProxyHeaders({ authorization: unrelated }, dashboardToken).authorization, unrelated,
      'unrelated upstream Basic credentials remain compatible');
  }
  assert.equal(sanitizeProxyHeaders({ authorization: 'Bearer allowed' }, dashboardToken).authorization,
    'Bearer allowed');
});

test('actual gateway proxy does not forward lowercase Sales Basic credentials', async t => {
  const observed = [];
  const upstream = http.createServer((req, res) => {
    observed.push(req.headers.authorization);
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const salesModule = { html: () => '', status: () => ({}), handleEvent: async () => null };
  const gateway = createGateway({
    upstreamPort: upstream.address().port,
    dashboardToken,
    bitrixToken: 'local-test-event-token',
    salesModule,
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => gateway.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  });

  for (const scheme of ['basic', 'BASIC', 'bAsIc']) {
    const response = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1', port: gateway.address().port, path: '/health',
        headers: { authorization: basic(scheme, 'sales', dashboardToken) },
      }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
    });
    assert.equal(response, 200);
  }
  assert.deepEqual(observed, [undefined, undefined, undefined]);
});
