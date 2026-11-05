'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Injected in-memory Bitrix replies only: no production CRM, Sheets or Render.
function snapshotForCategory(entityTypeId) {
  const category = { id: 0, name: 'Main' };
  if (entityTypeId !== undefined) category.entityTypeId = entityTypeId;
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [category] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }]
        : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return { result: { items: [{
      id: 19, categoryId: 0, stageId: 'NEW', title: 'Example',
      opportunity: '100.25', currencyId: 'RUB',
    }] }, total: 1 };
  }).snapshot();
}

test('a pipeline explicitly belonging to another CRM entity cannot certify deal counts', async t => {
  for (const foreign of [1, '1', 3, '3']) {
    await t.test('entityTypeId ' + String(foreign), async () => {
      await assert.rejects(snapshotForCategory(foreign), /invalid crm pipeline entity/i);
    });
  }
});

test('malformed CRM pipeline entity metadata cannot masquerade as deal entity 2', async t => {
  for (const invalid of [['2'], { toString: null }, true, '02', 2.5]) {
    await t.test(JSON.stringify(invalid), async () => {
      await assert.rejects(snapshotForCategory(invalid), /invalid crm pipeline entity/i);
    });
  }
});

test('correct and optional entityTypeId metadata remain compatible with deal category scan', async t => {
  for (const correct of [2, '2', null, undefined]) {
    await t.test(String(correct), async () => {
      const result = await snapshotForCategory(correct);
      assert.equal(result.counts.activeDeals, 1);
      assert.equal(result.activeDealAmountRUB, 100.25);
    });
  }
});
