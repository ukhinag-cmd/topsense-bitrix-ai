'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Preparation adapter only. All CRM reads are injected mock responses.
// A noncanonical textual item ID can alias a genuine deal/lead ID after
// Number() coercion and make a supposedly verified CRM snapshot misleading.
function withItemId(id, entityTypeId) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const stageEntity = entityTypeId === 1 ? 'STATUS' : 'DEAL_STAGE';
      const statuses = params.filter.ENTITY_ID === stageEntity
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, EXTRA: { SEMANTICS: 'process' } }]
        : [];
      return { result: statuses, total: statuses.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, entityTypeId);
    return { result: { items: [{
      id, categoryId: 0, stageId: 'NEW', title: 'Verified item',
      assignedById: 7, opportunity: '120.50', currencyId: 'RUB',
      createdTime: '2026-11-01T10:00:00+03:00',
      updatedTime: '2026-11-01T10:00:00+03:00',
    }] }, total: 1 };
  });
}

test('read-only adapter rejects noncanonical CRM item identities instead of coercing aliases', async t => {
  const invalid = ['007', '7e0', '7.0', ' 7 ', '0x7', '+7', '9007199254740992'];
  for (const entityTypeId of [1, 2]) {
    for (const id of invalid) {
      await t.test('entity ' + entityTypeId + ' id ' + JSON.stringify(id), async () => {
        await assert.rejects(withItemId(id, entityTypeId).snapshot(),
          /invalid.*crm.*identity|invalid.*item.*id/i);
      });
    }
  }
});

test('read-only adapter still accepts canonical numeric/string IDs for deals and leads', async t => {
  for (const entityTypeId of [1, 2]) {
    for (const id of [7, '7']) {
      await t.test('entity ' + entityTypeId + ' id ' + JSON.stringify(id), async () => {
        const snapshot = await withItemId(id, entityTypeId).snapshot();
        assert.equal(snapshot.counts.queue, 1);
        const entity = entityTypeId === 1 ? 'lead' : 'deal';
        assert.equal(snapshot.priorityQueue[0].key, entity + ':7');
      });
    }
  }
});
