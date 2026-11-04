'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createReadOnlySalesAdapter} = require('./sales-bitrix-readonly');

// Dormant read-only preparation adapter. Injected mocks only; no network calls.
function adapterWithCategory(id) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return {result: {categories: [{id, name: 'Main'}]}, total: 1};
    if (method === 'crm.status.list')
      return {result: [], total: 0};
    throw new Error('Unexpected CRM method: ' + method);
  });
}

test('read-only pipeline identifiers remain canonical and safe', async t => {
  for (const id of ['00', '01', '0.0', '1e0', ' 0 ', '7 ']) {
    await t.test('reject malformed Bitrix category ID ' + JSON.stringify(id), async () => {
      await assert.rejects(adapterWithCategory(id).snapshot(),
        /invalid.*pipeline|invalid.*crm.*identity|invalid.*category/i);
    });
  }

  await t.test('a non-safe pipeline selection is rejected, not treated as empty', async () => {
    await assert.rejects(
      adapterWithCategory(0).snapshot({pipelineIds: [Number.MAX_SAFE_INTEGER + 1]}),
      /invalid pipelineIds/i);
  });

  for (const id of [0, '0', 7, '7']) {
    await t.test('canonical Bitrix category ' + JSON.stringify(id) + ' is accepted', async () => {
      const result = await adapterWithCategory(id).snapshot();
      assert.deepEqual(result.funnels.map(p => p.id), [Number(id)]);
      assert.equal(result.counts.queue, 0);
    });
  }
});
