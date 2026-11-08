'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

const token = 'test-only-dashboard-secret';
const basic = 'Basic ' + Buffer.from('sales:' + token).toString('base64');

function request(port, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/sales/status',
      // An HTTP client can send repeated Authorization header lines. Node
      // retains both in req.rawHeaders but silently keeps the first in
      // req.headers.authorization by default.
      headers: { authorization },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

test('read-only Sales Basic auth rejects conflicting duplicated HTTP Authorization headers', async t => {
  const gateway = createGateway({
    dashboardToken: token,
    bitrixToken: 'not-used',
    salesModule: { html: () => 'safe', status: () => ({ ok: true }) },
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const port = gateway.address().port;

  assert.equal(await request(port, basic), 200, 'single valid credential stays supported');
  for (const credentials of [
    [basic, 'Basic ' + Buffer.from('sales:wrong').toString('base64')],
    ['Basic ' + Buffer.from('sales:wrong').toString('base64'), basic],
    [basic, basic],
  ]) {
    assert.equal(await request(port, credentials), 401,
      'ambiguous HTTP Authorization must not grant Dashboard access');
  }
});
