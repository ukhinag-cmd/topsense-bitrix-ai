'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Dormant adapter only. No Bitrix, Render or Google Sheets requests are made.
test('read-only RUB subtotal uses trustworthy kopecks instead of floating point', async t => {
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
      return { result: { items: amounts.map((amount, index) => ({
        id: index + 1, title: 'Mock deal', stageId: 'NEW',
        categoryId: 0, opportunity: amount, currencyId: 'RUB',
        createdTime: '2026-11-01T10:00:00+03:00',
        updatedTime: '2026-11-01T10:00:00+03:00',
      })) }, total: amounts.length };
    };
    return createReadOnlySalesAdapter(request).snapshot();
  }

  await t.test('ten and twenty kopecks yield exactly 0.30 RUB', async () => {
    const result = await snapshot(['0.10', '0.20']);
    assert.equal(result.activeDealAmountRUB, 0.3);
    assert.equal(result.counts.activeDeals, 2);
    assert.equal(result.priorityQueue.length, 2);
  });
  await t.test('a lost kopeck cannot conceal overflow past MAX_SAFE_INTEGER RUB', async () => {
    const result = await snapshot(['9007199254740991', '0.01']);
    assert.equal(result.activeDealAmountRUB, null);
    assert.equal(result.counts.activeDeals, 2);
  });
  for (const [name, amount] of [
    ['invalid numeric text', 'garbage'],
    ['empty numeric text', ''],
    ['JSON array coercible to zero', []],
    ['sub-kopeck amount', '0.001'],
    ['missing amount', null],
  ]) {
    await t.test(name + ' makes the subtotal unknown, not falsely smaller', async () => {
      const result = await snapshot(['100.00', amount]);
      assert.equal(result.activeDealAmountRUB, null);
      assert.equal(result.counts.activeDeals, 2);
      assert.equal(result.priorityQueue.length, 2);
      assert.equal(result.priorityQueue.find(d => d.id === 2).amountRUB, null);
    });
  }
  await t.test('normal decimal strings and numeric amounts remain usable', async () => {
    const result = await snapshot(['100.25', 250.5]);
    assert.equal(result.activeDealAmountRUB, 350.75);
    assert.equal(result.counts.activeDeals, 2);
  });
});
