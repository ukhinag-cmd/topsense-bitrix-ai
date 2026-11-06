'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Memory-only Bitrix transport. An observed CRM creation/update cannot be
// in the future: otherwise a corrupt item may top the new-lead queue, while
// the adapter falsely declares the snapshot reliable.
function leadAdapter(overrides) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list') {
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    }
    if (method === 'crm.status.list') {
      return { result: params.filter.ENTITY_ID === 'STATUS'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }] : [] };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 1);
    return { result: { items: [{
      id: 45, title: 'Lead 45', stageId: 'NEW',
      createdTime: new Date(Date.now() - 60_000).toISOString(),
      updatedTime: new Date().toISOString(),
      opportunity: '0', currencyId: 'RUB', ...overrides,
    }] }, total: 1 };
  });
}

test('read-only queue rejects future Bitrix observed timestamps rather than prioritizing fictitious new leads', async () => {
  const future = new Date(Date.now() + 11 * 60_000).toISOString();
  for (const field of ['createdTime', 'updatedTime']) {
    await assert.rejects(leadAdapter({ [field]: future }).snapshot(),
      /invalid crm item (created|updated) time/i,
      'reject ' + field + ' more than 10 minutes ahead of observed wall clock');
  }
});

test('near-future Bitrix clock skew remains accepted', async () => {
  const skew = new Date(Date.now() + 9 * 60_000).toISOString();
  const snapshot = await leadAdapter({ createdTime: skew, updatedTime: skew }).snapshot();
  assert.equal(snapshot.counts.newLeads, 1);
  assert.equal(snapshot.priorityQueue[0].createdAt, skew);
});
