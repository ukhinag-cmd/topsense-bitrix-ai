'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// All CRM responses are injected in memory. This dormant adapter never
// contacts Bitrix24, Sheets, Render or any live Sales service.
function adapterFor(statusId) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = ['STATUS', 'DEAL_STAGE'].includes(params.filter.ENTITY_ID)
        ? [{ STATUS_ID: statusId, NAME: 'Open', SORT: 10, SEMANTICS: null }] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    const lead = params.entityTypeId === 1;
    return { result: { items: [{
      id: lead ? 11 : 21,
      title: lead ? 'Lead' : 'Deal',
      stageId: statusId,
      ...(lead ? {} : { categoryId: 0 }),
      assignedById: 7, currencyId: 'RUB', opportunity: '100.25',
    }] }, total: 1 };
  });
}

test('zero-valued scalar Bitrix STATUS_ID must not vanish as an empty stage', async t => {
  for (const statusId of [0, '0']) {
    await t.test('stage identity ' + JSON.stringify(statusId), async () => {
      const snapshot = await adapterFor(statusId).snapshot();
      assert.equal(snapshot.counts.newLeads, 1);
      assert.equal(snapshot.counts.activeDeals, 1);
      assert.equal(snapshot.counts.queue, 2);
      assert.equal(snapshot.activeDealAmountRUB, 100.25);
      assert.deepEqual(snapshot.priorityQueue.map(row => row.stageId), ['0', '0']);
    });
  }
});
