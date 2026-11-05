'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// All Bitrix responses are injected in memory. The preparation adapter is
// dormant and cannot contact production, Google Sheets or Render.
function adapterFor(currencies) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'Open', SORT: 10, SEMANTICS: null }]
        : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    const items = currencies.map((currencyId, index) => ({
      id: index + 1, title: 'Mock opportunity', categoryId: 0, stageId: 'NEW',
      currencyId, opportunity: '100.25', assignedById: 7,
      createdTime: '2026-11-05T09:00:00+03:00',
      updatedTime: '2026-11-05T10:00:00+03:00',
    }));
    return { result: { items }, total: items.length };
  });
}

test('padded CRM RUB currency must contribute to the read-only RUB subtotal', async () => {
  // The active sales.js Dashboard already trims currency before identifying
  // RUB. The dormant adapter must not silently classify padded RUB as foreign.
  const snapshot = await adapterFor([' RUB ', 'rub', ' USD ']).snapshot();
  assert.equal(snapshot.counts.activeDeals, 3);
  assert.equal(snapshot.activeDealAmountRUB, 200.5);
  assert.equal(snapshot.nonRubDealCount, 1);
  assert.deepEqual(snapshot.priorityQueue.map(row => row.currency).sort(),
    ['RUB', 'RUB', 'USD']);
  assert.deepEqual(snapshot.priorityQueue.filter(row => row.currency === 'RUB')
    .map(row => row.amountRUB), [100.25, 100.25]);
});

test('missing currency remains unknown, not silently assumed to be RUB', async () => {
  const snapshot = await adapterFor([null]).snapshot();
  assert.equal(snapshot.counts.activeDeals, 1);
  assert.equal(snapshot.priorityQueue[0].amountRUB, null);
  assert.equal(snapshot.activeDealAmountRUB, 0);
});
