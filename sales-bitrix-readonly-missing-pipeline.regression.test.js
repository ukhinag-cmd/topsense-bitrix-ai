'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Mock-only read contract. A caller asking for a particular Bitrix funnel must
// not receive a credible-looking zero-deal snapshot when crm.category.list
// omitted that funnel (e.g. insufficient CRM visibility or a stale ID).
function adapter() {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list') {
      return {
        result: { categories: [{ id: 0, name: 'Default' }, { id: 7, name: 'Secondary' }] },
        total: 2,
      };
    }
    if (method === 'crm.status.list') {
      const entity = params.filter.ENTITY_ID;
      const stages = entity === 'DEAL_STAGE' ? [
        { STATUS_ID: 'NEW', NAME: 'New', SORT: 10, EXTRA: { SEMANTICS: 'process' } },
      ] : entity === 'DEAL_STAGE_7' ? [
        { STATUS_ID: 'C7:NEW', NAME: 'New in 7', SORT: 10, EXTRA: { SEMANTICS: 'process' } },
      ] : [];
      return { result: stages, total: stages.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    const id = params.filter.categoryId;
    return {
      result: { items: [{
        id: id === 0 ? 10 : 70, title: 'Mock deal',
        stageId: id === 0 ? 'NEW' : 'C7:NEW',
        categoryId: id, assignedById: 9, currencyId: 'RUB', opportunity: '150.25',
      }] },
      total: 1,
    };
  });
}

test('unknown requested funnel must fail closed instead of claiming zero active deals', async () => {
  await assert.rejects(adapter().snapshot({ pipelineIds: [999] }), /pipeline.*(missing|unknown|not found)/i);
  await assert.rejects(adapter().snapshot({ pipelineIds: [0, 999] }), /pipeline.*(missing|unknown|not found)/i);
});

test('known funnel selection and deliberate empty selection keep their semantics', async () => {
  const one = await adapter().snapshot({ pipelineIds: [0] });
  assert.equal(one.counts.activeDeals, 1);
  assert.equal(one.activeDealAmountRUB, 150.25);
  const other = await adapter().snapshot({ pipelineIds: [7] });
  assert.equal(other.counts.activeDeals, 1);
  const none = await adapter().snapshot({ pipelineIds: [] });
  assert.equal(none.counts.activeDeals, 0);
  assert.equal(none.activeDealAmountRUB, 0);
});
