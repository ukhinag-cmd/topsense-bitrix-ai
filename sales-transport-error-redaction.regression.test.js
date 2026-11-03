'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Use an isolated module and a mocked fetch: no real Bitrix or Sheet traffic.
function harness() {
  const secret = 'test-only-credential-943816';
  const env = {
    BITRIX_WEBHOOK_BASE: 'https://bitrix.example.test/rest/1/' + secret + '/',
    GOOGLE_SHEET_STORE_URL: 'https://store.example.test/sales',
    GOOGLE_SHEET_STORE_SECRET: secret,
  };
  let mode = 'bitrix-transport';
  const fetch = async (input, options = {}) => {
    assert.equal(options.redirect, mode.startsWith('bitrix') ? 'error' : 'manual');
    if (mode === 'bitrix-transport' || mode === 'store-transport') {
      // Network/proxy errors can embed the request URL and even credentials.
      throw new Error('Transport error for ' + String(input) + ' with ' + secret);
    }
    if (mode === 'store-provider-error') {
      return {
        ok: false, status: 403,
        text: async () => JSON.stringify({ ok: false, error: 'Provider denied: ' + secret }),
      };
    }
    if (mode === 'bitrix-ok') {
      return { ok: true, status: 200, json: async () => ({ result: { ID: '1' } }) };
    }
    if (mode === 'store-ok') {
      return { ok: true, status: 200, text: async () => '{"rows":[]}' };
    }
    throw new Error('unexpected mock mode');
  };
  const context = {
    module: { exports: {} }, process: { env }, URL, Buffer, AbortSignal, fetch, console,
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__readForTest = bitrixRaw; module.exports.__storeForTest = storeRequest;',
    context, { filename: 'sales.js' });
  return {
    secret, setMode: value => { mode = value; },
    read: context.module.exports.__readForTest,
    store: context.module.exports.__storeForTest,
  };
}

async function expectSafeFailure(promise, secret, source) {
  await assert.rejects(promise, error => {
    assert.equal(error.message.includes(secret), false,
      source + ' error must not echo credentials in logs or Sales health');
    assert.match(error.message, /Bitrix|Sales store/i,
      'retain a useful, non-sensitive failure category');
    return true;
  });
}

test('Bitrix transport exceptions cannot expose credential-bearing webhook URLs', async () => {
  const h = harness();
  await expectSafeFailure(h.read('crm.deal.get', { ID: 1 }), h.secret, 'Bitrix');
  h.setMode('bitrix-ok');
  const response = await h.read('crm.deal.get', { ID: 1 });
  assert.equal(response.result.ID, '1', 'successful read-only requests must still work');
});

test('Google Sheet store transport exceptions cannot expose credentials', async () => {
  const h = harness();
  h.setMode('store-transport');
  await expectSafeFailure(h.store('load'), h.secret, 'Store transport');
  h.setMode('store-ok');
  const response = await h.store('load');
  assert.equal(Array.isArray(response.rows), true, 'valid read-only history must still load');
});

test('untrusted store JSON error descriptions cannot expose shared secrets', async () => {
  const h = harness();
  h.setMode('store-provider-error');
  await expectSafeFailure(h.store('load'), h.secret, 'Store response');
});
