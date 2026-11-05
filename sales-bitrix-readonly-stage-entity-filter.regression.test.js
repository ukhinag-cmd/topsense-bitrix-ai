'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// No external CRM calls. A returned stage must belong to the requested
// Bitrix status entity or it can leak another pipeline's classification
// into the supposedly complete, read-only Sales Dashboard snapshot.
const baseStage = {
  STATUS_ID: 'NEW', NAME: 'New', SORT: 10,
  EXTRA: { SEMANTICS: 'process' },
};
function adapterFor(stage) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE' ? [stage] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return { result: { items: [{
      id: 7, title: 'Deal', stageId: 'NEW', categoryId: 0,
      assignedById: 9, opportunity: '100.25', currencyId: 'RUB',
    }] }, total: 1 };
  });
}

test('stage metadata must not cross requested Bitrix entity/pipeline boundaries', async t => {
  for (const [label, entityId] of [
    ['foreign deal pipeline', 'DEAL_STAGE_7'],
    ['lead-status namespace', 'STATUS'],
    ['array masquerading as correct ID', ['DEAL_STAGE']],
    ['object masquerading as correct ID', { toString: () => 'DEAL_STAGE' }],
    ['null is a valid absent metadata value, not a foreign ID', null],
  ]) {
    await t.test(label, async () => {
      const read = adapterFor({ ...baseStage, ENTITY_ID: entityId }).snapshot();
      if (entityId === null) {
        assert.equal((await read).counts.activeDeals, 1);
      } else {
        await assert.rejects(read, /invalid crm stage entity|stage.*entity.*filter/i);
      }
    });
  }
  for (const entityId of ['DEAL_STAGE', undefined]) {
    const result = await adapterFor({ ...baseStage, ENTITY_ID: entityId }).snapshot();
    assert.equal(result.counts.activeDeals, 1);
    assert.equal(result.activeDealAmountRUB, 100.25);
  }
});
