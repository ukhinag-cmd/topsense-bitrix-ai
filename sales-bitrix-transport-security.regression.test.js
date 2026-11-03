'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The outbound Bitrix webhook URL contains a credential in its path.
// Never make a request to an unencrypted or URL-userinfo endpoint, and
// never let Fetch forward CRM read parameters to an unexpected redirect.
test('Sales Bitrix reads reject unsafe transport before network I/O', async () => {
  const env = { BITRIX_WEBHOOK_BASE: '' };
  const outbound = [];
  const context = {
    module: { exports: {} },
    process: { env },
    URL,
    AbortSignal,
    console,
    fetch: async (input, options) => {
      outbound.push({ url: String(input), options });
      return { ok: true, status: 200, json: async () => ({ result: { ID: '1' } }) };
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__testBitrixRaw = bitrixRaw;',
    context, { filename: 'sales.js' });
  const send = context.module.exports.__testBitrixRaw;

  for (const unsafeUrl of [
    'http://bitrix.example.test/rest/1/secret/',
    'https://username:password@bitrix.example.test/rest/1/secret/',
    'ftp://bitrix.example.test/rest/1/secret/',
  ]) {
    env.BITRIX_WEBHOOK_BASE = unsafeUrl;
    await assert.rejects(send('crm.deal.get', { ID: 1 }),
      /Invalid Bitrix webhook URL|Insecure Bitrix webhook URL/,
      'a credential-bearing Bitrix read must fail closed');
  }
  assert.equal(outbound.length, 0,
    'unsafe Bitrix endpoints must be rejected before any request');

  env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/1/secret/';
  const result = await send('crm.deal.get', { ID: 1 });
  assert.equal(result.result.ID, '1');
  assert.equal(outbound.length, 1, 'valid HTTPS Bitrix reads still work');
  assert.equal(outbound[0].options.method, 'POST');
  assert.equal(outbound[0].options.redirect, 'error',
    'Fetch must never replay Bitrix data to an unexpected redirect');
  assert.equal(new URL(outbound[0].url).pathname, '/rest/1/secret/crm.deal.get.json');
});
