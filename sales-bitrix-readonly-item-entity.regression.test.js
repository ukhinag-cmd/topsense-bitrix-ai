'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Dormant adapter; every Bitrix response is an in-memory mock. A provider
// returning a row from another CRM entity must not certify Sales counts
// merely because its ID and stage happen to match the requested filter.
function snapshotFor(type, entityTypeId) {
  const expected = type === 'lead' ? 1 : 2;
  const row = {
    id: 23, title: 'Test', stageId: 'NEW',
    assignedById: 7, opportunity: '300.25', currencyId: 'RUB',
    createdTime: '2026-11-05T09:00:00+03:00',
    updatedTime: '2026-11-05T09:00:00+03:00',
  };
  if (type === 'deal') row.categoryId = 0;
  if (entityTypeId !== undefined) row.entityTypeId = entityTypeId;
  const transport = async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const isLead = params.filter.ENTITY_ID === 'STATUS';
      const rows = isLead === (type === 'lead')
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }]
        : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, expected);
    return { result: { items: [row] }, total: 1 };
  };
  return createReadOnlySalesAdapter(transport).snapshot(type === 'lead' ? { pipelineIds: [] } : {});
}

test('foreign CRM entity metadata must not certify lead or deal totals', async t => {
  for (const type of ['lead', 'deal']) {
    const foreign = type === 'lead' ? 2 : 1;
    for (const value of [foreign, String(foreign), 3]) {
      await t.test(type + ': foreign entity ' + String(value), async () => {
        await assert.rejects(snapshotFor(type, value), /invalid crm item entity/i);
      });
    }
  }
});

test('malformed CRM entity metadata cannot masquerade as a matching item', async t => {
  for (const type of ['lead', 'deal']) {
    const correct = type === 'lead' ? '1' : '2';
    for (const value of [[correct], { toString: () => correct }, true, '0' + correct, Number(correct) + 0.5]) {
      await t.test(type + ': ' + JSON.stringify(value), async () => {
        await assert.rejects(snapshotFor(type, value), /invalid crm item entity/i);
      });
    }
  }
});

test('correct or omitted optional CRM entity metadata remains compatible', async t => {
  for (const type of ['lead', 'deal']) {
    const correct = type === 'lead' ? 1 : 2;
    for (const value of [correct, String(correct), null, undefined]) {
      await t.test(type + ': ' + String(value), async () => {
        const snapshot = await snapshotFor(type, value);
        assert.equal(snapshot.counts[type === 'lead' ? 'newLeads' : 'activeDeals'], 1);
        if (type === 'deal') assert.equal(snapshot.activeDealAmountRUB, 300.25);
      });
    }
  }
});
