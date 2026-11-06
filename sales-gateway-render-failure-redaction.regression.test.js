'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const secret = 'test-only-sensitive-webhook-token-do-not-log';
const basic = 'Basic ' + Buffer.from('sales:dashboard-test-token').toString('base64');

function gatewayHandler(salesModule) {
  // Capture the real gateway's request listener without opening a port or
  // invoking production Bitrix/Render/Sheets services.
  let listener;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./sales-gateway'), 'utf8'), {
    require(name) {
      if (name === 'http') return {
        createServer(fn) { listener = fn; return { close() {} }; },
      };
      return require(name);
    },
    module, exports: module.exports, process, Buffer, URL,
  }, { filename: 'sales-gateway.js' });
  module.exports.createGateway({
    dashboardToken: 'dashboard-test-token', salesModule,
  });
  return listener;
}

function request(handler, url) {
  const headers = {};
  const response = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(code, extra = {}) {
      this.statusCode = code;
      for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
    },
    end(body) { this.body = String(body || ''); },
    headers,
  };
  assert.doesNotThrow(() => handler({
    method: 'GET', url, headers: { authorization: basic },
  }, response), 'read-only Sales GET must not throw out of the HTTP listener');
  return response;
}

test('read-only Dashboard rendering failures are sanitized and return 503, not an unhandled secret-bearing error', () => {
  for (const route of ['/sales', '/sales/status']) {
    const handler = gatewayHandler({
      html() { throw new Error('Bitrix URL contains ' + secret); },
      status() { throw new Error('Bitrix URL contains ' + secret); },
    });
    const response = request(handler, route);
    assert.equal(response.statusCode, 503, route);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.doesNotMatch(response.body, new RegExp(secret));
    assert.match(response.body, /unavailable/i);
  }
});

test('unserializable Sales status never escapes the read-only HTTP handler', () => {
  const cycle = {};
  cycle.self = cycle;
  const response = request(gatewayHandler({
    html() { return '<h1>OK</h1>'; },
    status() { return cycle; },
  }), '/sales/status');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
});
