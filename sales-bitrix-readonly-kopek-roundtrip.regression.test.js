'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// The preparation adapter is dormant. The transport below is a local mock;
// no live Bitrix, Render or Google Sheets requests are made.
test('read-only Dashboard does not label rounded RUB kopecks as exact', async t => {
  async function snapshot(amounts) {
    const request = async (method, params) => {
      if (method === 'crm.category.list')
        return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
      if (method === 'crm.status.list') {
        const rows = params.filter.ENTITY_ID === 'STATUS' ? [] : [{
          STATUS_ID: 'NEW', NAME: 'New', SORT: 10,
          EXTRA: { SEMANTICS: 'process' },
        }];
        return { result: rows, total: rows.length };
      }
      assert.equal(method, 'crm.item.list');
      assert.equal(params.entityTypeId, 2);
      return { result: { items: amounts.map((opportunity, index) => ({
        id: index + 1, title: 'Mock', stageId: 'NEW', categoryId: 0,
        currencyId: 'RUB', opportunity,
        createdTime: '2026-11-01T10:00:00+03:00',
        updatedTime: '2026-11-01T10:00:00+03:00',
      })) }, total: amounts.length };
    };
    return createReadOnlySalesAdapter(request).snapshot();
  }

  await t.test('a single amount whose kopeck is rounded by Number becomes unknown', async () => {
    const result = await snapshot(['100000000000000.01']);
    assert.equal(result.counts.activeDeals, 1);
    assert.equal(result.priorityQueue[0].amountRUB, null,
      '100000000000000.01 is rounded to .02 by Number');
    assert.equal(result.activeDealAmountRUB, null,
      'the subtotal must not present a different cent amount as trusted');
  });

  await t.test('two accurately displayed amounts can produce an inaccurate subtotal', async () => {
    const result = await snapshot(['40000000000000.02', '40000000000000.02']);
    assert.equal(result.counts.activeDeals, 2);
    assert.equal(result.priorityQueue[0].amountRUB, 40000000000000.02);
    assert.equal(result.priorityQueue[1].amountRUB, 40000000000000.02);
    assert.equal(result.activeDealAmountRUB, null,
      '80000000000000.04 rounds to .05 and must not be shown as exact');
  });

  await t.test('ordinary fractional RUB amounts remain available', async () => {
    const result = await snapshot(['100.25', '250.50']);
    assert.equal(result.priorityQueue[0].amountRUB, 250.5);
    assert.equal(result.priorityQueue[1].amountRUB, 100.25);
    assert.equal(result.activeDealAmountRUB, 350.75);
  });
});
