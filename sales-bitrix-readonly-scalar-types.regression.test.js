'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Dormant adapter only: injected mock transport, no real Bitrix/Render/Sheets.
const deal = {
  id: 7, title: 'Checked deal', categoryId: 0, stageId: 'NEW',
  assignedById: 9, opportunity: '100.25', currencyId: 'RUB',
  createdTime: '2026-11-01T10:00:00+03:00',
  updatedTime: '2026-11-01T10:00:00+03:00',
};
function adapterFor(row, entityTypeId = 2) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const selected = entityTypeId === 1 ? 'STATUS' : 'DEAL_STAGE';
      const rows = params.filter.ENTITY_ID === selected
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10,
             EXTRA: { SEMANTICS: 'process' } }] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, entityTypeId);
    return { result: { items: [row] }, total: 1 };
  });
}

test('read-only adapter rejects non-scalar CRM item stage IDs', async t => {
  for (const entityTypeId of [1, 2]) {
    await t.test('entity ' + entityTypeId + ': array stage must not masquerade as NEW', async () => {
      const row = { ...deal, stageId: ['NEW'] };
      await assert.rejects(
        adapterFor(row, entityTypeId).snapshot(),
        /invalid.*stage|requested stage filter|stage.*invalid/i);
    });
  }
});

test('read-only adapter rejects non-scalar currency instead of fabricating RUB totals', async t => {
  for (const currencyId of [['RUB'], ['USD'], true]) {
    await t.test('currency ' + JSON.stringify(currencyId), async () => {
      await assert.rejects(
        adapterFor({ ...deal, currencyId }).snapshot(),
        /invalid.*currency|currency.*invalid/i);
    });
  }
});

test('valid scalar stage and currency still produce a read-only count and subtotal', async () => {
  const result = await adapterFor(deal).snapshot();
  assert.equal(result.counts.activeDeals, 1);
  assert.equal(result.activeDealAmountRUB, 100.25);
  assert.equal(result.priorityQueue[0].stageId, 'NEW');
  assert.equal(result.priorityQueue[0].currency, 'RUB');
});
