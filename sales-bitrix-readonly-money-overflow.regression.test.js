'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// This adapter remains unconnected to production. All CRM calls are injected mocks.
// A numerically unsafe RUB subtotal must never appear as a trusted money figure.
test('dormant read-only Dashboard refuses unsafe RUB subtotals', async t => {
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
      return {
        result: { items: amounts.map((amount, index) => ({
          id: index + 1, title: 'Safe individual RUB deal',
          categoryId: 0, stageId: 'NEW', opportunity: amount,
          currencyId: 'RUB', assignedById: 8,
          createdTime: '2026-11-01T10:00:00+03:00',
          updatedTime: '2026-11-01T10:00:00+03:00',
        })) },
        total: amounts.length,
      };
    };
    return createReadOnlySalesAdapter(request).snapshot();
  }

  await t.test('two individually safe values may overflow total integer precision', async () => {
    const result = await snapshot(['5000000000000000', '5000000000000000']);
    assert.equal(result.counts.activeDeals, 2);
    assert.equal(result.priorityQueue.length, 2);
    assert.equal(result.activeDealAmountRUB, null,
      'an unsafe 10 quadrillion RUB total must be marked unavailable');
  });
  await t.test('ordinary RUB amounts, including kopecks, remain available', async () => {
    const result = await snapshot(['100.25', '250.50']);
    assert.equal(result.activeDealAmountRUB, 350.75);
    assert.equal(result.counts.activeDeals, 2);
  });
});
