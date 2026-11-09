'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Offline, injected responses only. Never access a real Sheet, CRM or Render.
test('explicit malformed store load acknowledgements must not erase trusted Sales history silently', async () => {
  const url = 'https://store-load-ack.mock.test/exec';
  const secret = 'synthetic-secret';
  let body = '{"rows":[]}';
  const ctx = {
    module: { exports: {} },
    process: { env: { GOOGLE_SHEET_STORE_URL: url, GOOGLE_SHEET_STORE_SECRET: secret } },
    URL, AbortSignal, console,
    fetch: async (input, options) => {
      assert.equal(String(input), url);
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).action, 'load');
      return { ok: true, status: 200, text: async () => body };
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__storeRequestForTest = storeRequest;',
    ctx, { filename: 'sales.js' });
  const read = ctx.module.exports.__storeRequestForTest;

  // Older Sheet store implementations legitimately omitted "ok" on loads.
  assert.equal((await read('load')).rows.length, 0);
  body = '{"ok":true,"rows":[]}';
  assert.equal((await read('load')).rows.length, 0);

  // A present, non-boolean failure/acknowledgement must never be confused
  // with an authenticated successful history load just because HTTP is 200.
  for (const value of ['false', '"false"', '0', 'null', '[]', '{}']) {
    body = '{"ok":' + value + ',"rows":[]}';
    await assert.rejects(read('load'), /Sales store response failed/,
      'malformed explicit store ok=' + value + ' was accepted');
  }
});
