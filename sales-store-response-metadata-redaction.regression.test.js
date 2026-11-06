'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Offline VM: all HTTP responses are injected; no live store, CRM or Render calls.
// GOOGLE_SHEET_STORE_SECRET is synthetic and must not reach diagnostic errors.
test('Sales store response metadata accessors cannot leak its shared secret', async () => {
  const secret = 'fake-sales-store-secret-NEVER-LOG';
  const storeUrl = 'https://script.google.com/macros/s/test-only/exec';
  const googleUrl = 'https://script.googleusercontent.com/macros/echo?test=1';
  let response;
  const requests = [];
  const context = {
    module: { exports: {} },
    process: { env: { GOOGLE_SHEET_STORE_URL: storeUrl, GOOGLE_SHEET_STORE_SECRET: secret } },
    URL, AbortSignal, console,
    fetch: async (input, options) => {
      requests.push({ url: String(input), options });
      if (String(input) === googleUrl) {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined, 'redirected requests must omit the secret');
        return { ok: true, status: 200, text: async () => '{"rows":[]}' };
      }
      assert.equal(String(input), storeUrl);
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).secret, secret);
      return response;
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__testStoreRequest = storeRequest;',
    context, { filename: 'sales.js' });
  const storeRequest = context.module.exports.__testStoreRequest;
  const credentialError = () => new Error('Untrusted transport response: ' + secret);
  const getter = (key, base = {}) => Object.defineProperty({ ...base }, key, {
    enumerable: true,
    get() { throw credentialError(); },
  });
  const tests = [
    ['HTTP status', getter('status', { ok: true, text: async () => '{"rows":[]}' })],
    ['HTTP ok', getter('ok', { status: 200, text: async () => '{"rows":[]}' })],
    ['redirect headers', getter('headers', { status: 302, ok: false })],
    ['redirect location accessor', {
      status: 302, ok: false,
      headers: { get() { throw credentialError(); } },
    }],
  ];
  for (const [label, hostileResponse] of tests) {
    response = hostileResponse;
    await assert.rejects(storeRequest('load'), error => {
      assert.match(error.message, /Sales store/i, label);
      assert.equal(String(error).includes(secret), false, label + ' leaked a store secret');
      assert.equal(String(error.stack || '').includes(secret), false, label + ' leaked into stack');
      assert.equal(error.cause, undefined, label + ' chained a raw transport exception');
      return true;
    });
  }

  response = { ok: true, status: 200, text: async () => '{"rows":[]}' };
  assert.equal((await storeRequest('load')).rows.length, 0,
    'normal HTTPS store load must remain compatible');

  response = {
    ok: false, status: 302,
    headers: { get: name => name.toLowerCase() === 'location' ? googleUrl : null },
  };
  const before = requests.length;
  assert.equal((await storeRequest('load')).rows.length, 0,
    'safe credential-free Google Apps Script redirect must remain compatible');
  assert.equal(requests.length, before + 2);
});
