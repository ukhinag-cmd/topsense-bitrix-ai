'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// All CRM requests use injected memory-only fixtures. This dormant adapter
// cannot contact Bitrix24, Google Sheets, Render or production services.
function adapterFor(overrides = {}) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return { result: { items: [{
      id: 7, title: 'Opportunity', stageId: 'NEW', categoryId: 0,
      assignedById: 3, opportunity: '1200.50', currencyId: 'RUB',
      createdTime: '2026-11-05T09:00:00+03:00',
      updatedTime: '2026-11-05T10:00:00+03:00',
      ...overrides,
    }] }, total: 1 };
  });
}

test('malformed CRM timestamps must not silently become missing queue/history dates', async t => {
  for (const [field, value] of [
    ['createdTime', ['2026-11-05T09:00:00+03:00']],
    ['updatedTime', { toString: null }],
    ['createdTime', 1793869200],
    ['updatedTime', false],
    ['createdTime', 'not-a-date'],
    ['updatedTime', '2026'],
  ]) {
    await t.test(field + ': ' + JSON.stringify(value), async () => {
      await assert.rejects(adapterFor({ [field]: value }).snapshot(),
        /invalid crm item (created|updated) time/i);
    });
  }
});

test('valid Bitrix ISO timestamps and explicitly absent dates remain compatible', async () => {
  const valid = await adapterFor().snapshot();
  assert.equal(valid.counts.activeDeals, 1);
  assert.equal(valid.priorityQueue[0].createdAt, '2026-11-05T09:00:00+03:00');
  assert.equal(valid.priorityQueue[0].updatedAt, '2026-11-05T10:00:00+03:00');
  const legacy = await adapterFor({ createdTime: null, updatedTime: undefined }).snapshot();
  assert.equal(legacy.counts.activeDeals, 1);
  assert.equal(legacy.priorityQueue[0].createdAt, null);
  assert.equal(legacy.priorityQueue[0].updatedAt, null);
});
