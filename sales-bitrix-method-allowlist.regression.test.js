'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the actual transport without publishing it as a public Sales API.
// No Bitrix network requests or store writes are made by this regression test.
test('Sales Bitrix transport rejects every non-allowlisted CRM method before network I/O', async () => {
  const sent = [];
  const allowed = [
    'crm.status.list', 'user.get', 'crm.deal.get',
    'crm.activity.get', 'crm.deal.list',
  ];
  const context = {
    module: { exports: {} },
    process: { env: { BITRIX_WEBHOOK_BASE: 'https://example.invalid/rest/1/test/' } },
    fetch: async (url, options) => {
      sent.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ result: { ok: true } }) };
    },
    URL,
    AbortSignal,
    console,
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__testBitrixRaw = bitrixRaw;', context, {
    filename: 'sales.js',
  });
  const send = context.module.exports.__testBitrixRaw;
  for (const method of allowed) {
    const response = await send(method, { ID: 1 });
    assert.equal(response.result.ok, true);
  }
  assert.deepEqual(sent.map(call => new URL(call.url).pathname.split('/').pop()),
    allowed.map(method => method + '.json'));
  assert.ok(sent.every(call => call.options.method === 'POST'),
    'Bitrix read-only REST methods may use POST as transport');

  for (const method of [
    'crm.deal.add', 'crm.deal.update', 'crm.deal.delete',
    'crm.activity.add', 'crm.item.update', 'batch',
    '../crm.deal.update', 'https://elsewhere.invalid/',
  ]) {
    await assert.rejects(send(method, { fields: { TITLE: 'must not write' } }),
      /Read-only Bitrix method blocked/);
  }
  assert.equal(sent.length, allowed.length,
    'rejected methods must never reach the network layer');
});
