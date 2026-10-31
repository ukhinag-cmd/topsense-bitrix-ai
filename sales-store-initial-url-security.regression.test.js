'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Sales store refuses insecure initial endpoints before sending the shared secret', async () => {
  const secret = 'transport-guard-test-only-secret';
  const env = {
    GOOGLE_SHEET_STORE_URL: '',
    GOOGLE_SHEET_STORE_SECRET: secret,
  };
  const outbound = [];
  const context = {
    module: { exports: {} },
    process: { env },
    URL, AbortSignal, console,
    fetch: async (input, options = {}) => {
      outbound.push({ url: String(input), options });
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ rows: [] }),
      };
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__testStoreRequest = storeRequest;',
    context, { filename: 'sales.js' });
  const storeRequest = context.module.exports.__testStoreRequest;

  for (const unsafeUrl of [
    'http://script.google.com/macros/s/test/exec',
    'https://user:pass@script.google.com/macros/s/test/exec',
    'ftp://script.google.com/macros/s/test/exec',
  ]) {
    env.GOOGLE_SHEET_STORE_URL = unsafeUrl;
    await assert.rejects(storeRequest('load'), /Invalid Sales store URL|Insecure Sales store URL/,
      'insecure or credential-bearing store endpoints must fail closed');
  }
  assert.equal(outbound.length, 0,
    'no request containing the shared secret may leave before URL validation');

  env.GOOGLE_SHEET_STORE_URL = 'https://script.google.com/macros/s/test/exec';
  const result = await storeRequest('load');
  assert.equal(result.rows.length, 0);
  assert.equal(outbound.length, 1, 'a normal HTTPS store read must keep working');
  assert.equal(outbound[0].options.method, 'POST');
  assert.equal(outbound[0].options.redirect, 'manual');
  assert.equal(JSON.parse(outbound[0].options.body).secret, secret);
});
