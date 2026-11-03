'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Isolate the gateway with a fake HTTP server and request transport. These
// regressions never contact Bitrix, Sheets, Render, or a legacy upstream.
function harness(secret) {
  const output = [];
  const fakeHttp = {
    createServer(handler) {
      return {
        handler,
        listen(_port, _host, callback) { callback(); },
        close() {},
      };
    },
    request() {
      const proxy = new EventEmitter();
      proxy.end = () => {};
      return proxy;
    },
  };
  const fakeSales = {
    start: async () => {
      throw new Error('Startup failed while reading https://bitrix.example.test/rest/1/' + secret + '/');
    },
    html: () => '<h1>Sales</h1>',
    status: () => ({ ok: true }),
    handleEvent: async () => null,
  };
  const context = {
    module: { exports: {} },
    process: { env: {}, on() {} },
    console: {
      log: (...args) => output.push(args.map(String).join(' ')),
      error: (...args) => output.push(args.map(String).join(' ')),
      warn: (...args) => output.push(args.map(String).join(' ')),
    },
    require: name => {
      if (name === 'http') return fakeHttp;
      if (name === './sales') return fakeSales;
      if (name === './sales-gateway-helpers') return require('./sales-gateway-helpers');
      if (name === 'crypto') return require('node:crypto');
      throw new Error('Unexpected module: ' + name);
    },
    Buffer, URL,
  };
  const source = fs.readFileSync(require.resolve('./sales-gateway'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'sales-gateway.js' });
  return { gateway: context.module.exports, output };
}

test('gateway upstream failures do not echo untrusted exception credentials to logs', () => {
  const secret = 'proxy-secret-do-not-log-49137';
  const h = harness(secret);
  const server = h.gateway.createGateway({
    upstreamPort: 12345,
    dashboardToken: 'test-only-dashboard-token',
    bitrixToken: 'test-only-bitrix-token',
  });
  let statusCode;
  server.handler({
    method: 'GET', url: '/legacy/read', headers: {},
    pipe(proxy) {
      proxy.emit('error', new Error('Proxy error involving ' + secret));
    },
  }, {
    headersSent: false,
    writeHead(code) { statusCode = code; this.headersSent = true; },
    end() {},
  });
  assert.equal(statusCode, 502);
  assert.match(h.output.join('\n'), /gateway-error/, 'gateway failure must remain observable');
  assert.equal(h.output.join('\n').includes(secret), false,
    'never log untrusted transport exception messages');
});

test('gateway startup errors do not disclose credential-bearing URLs in logs', async () => {
  const secret = 'startup-secret-do-not-log-98246';
  const h = harness(secret);
  h.gateway.start();
  await Promise.resolve();
  assert.match(h.output.join('\n'), /startup-error/, 'startup failure must remain observable');
  assert.equal(h.output.join('\n').includes(secret), false,
    'never log raw startup exception text');
});
