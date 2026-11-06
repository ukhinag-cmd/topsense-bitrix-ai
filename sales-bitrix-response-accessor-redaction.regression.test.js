'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Fully mocked, offline transport. A resolved fetch/JSON response must not be
// able to leak a credential via accessors after the network catch has ended.
test('live read-only Bitrix client redacts exceptions from resolved response accessors', async () => {
  const secret = 'fake-bitrix-webhook-credential-DO-NOT-LOG';
  const env = { BITRIX_WEBHOOK_BASE: 'https://bitrix.example.test/rest/1/' + secret + '/' };
  const credentialError = () => new Error('Unexpected access to ' + env.BITRIX_WEBHOOK_BASE);
  let response;
  const context = {
    module: { exports: {} }, process: { env }, URL, AbortSignal, console,
    fetch: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return response;
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__readForTest = bitrixRaw;',
    context, { filename: 'sales.js' });
  const read = context.module.exports.__readForTest;

  const withGetter = (key, otherwise = {}) => {
    const object = { ...otherwise };
    Object.defineProperty(object, key, {
      enumerable: true, get() { throw credentialError(); },
    });
    return object;
  };
  const goodResult = { result: { ID: '42' } };

  for (const bad of [
    { ok: true, status: 200, json: async () => withGetter('error', goodResult) },
    { ok: true, status: 200, json: async () => withGetter('result') },
    { ok: true, status: 200, json: async () => ({
      result: withGetter('ID'),
    }) },
    withGetter('ok', { status: 200, json: async () => goodResult }),
    withGetter('status', { ok: true, json: async () => goodResult }),
    { ok: true, status: 200, get json() { throw credentialError(); } },
  ]) {
    response = bad;
    await assert.rejects(read('crm.deal.get', { id: 42 }), error => {
      assert.match(error.message, /Bitrix REST crm\.deal\.get/);
      assert.equal(error.message.includes(secret), false,
        'secret-bearing resolved response accessors must be sanitized');
      assert.equal(String(error.stack).includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }

  response = { ok: true, status: 200, json: async () => goodResult };
  assert.equal((await read('crm.deal.get', { id: 42 })).result.ID, '42',
    'ordinary read-only REST responses must keep working');
});
