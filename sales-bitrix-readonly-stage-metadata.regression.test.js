'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// The preparation adapter is inert: only injected in-memory Bitrix responses.
// Invalid stage metadata must not turn real open rows into an empty queue or
// incorrectly call a progressed lead a newly created one.
const processStage = {
  STATUS_ID: 'NEW', NAME: 'New', SORT: 10,
  EXTRA: { SEMANTICS: 'process' },
};
function mockedStageMetadata(stages, entityTypeId = 2) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const requested = entityTypeId === 2 ? 'DEAL_STAGE' : 'STATUS';
      const rows = params.filter.ENTITY_ID === requested ? stages : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, entityTypeId);
    return { result: { items: [{
      id: 7, title: 'Progressed item', stageId: entityTypeId === 2 ? 'NEW' : 'IN_PROCESS',
      categoryId: 0, assignedById: 9, currencyId: 'RUB',
      opportunity: '100.25',
    }] }, total: 1 };
  });
}

test('invalid Bitrix stage semantics cannot silently suppress active deals', async t => {
  const malformed = [
    ['array process marker', { EXTRA: { SEMANTICS: ['process'] } }],
    ['array stage semantics', { SEMANTICS: ['S'] }],
    ['object stage semantics', { SEMANTICS: { toString: null } }],
    ['array EXTRA metadata', { EXTRA: ['process'] }],
    ['nonscalar EXTRA marker', { EXTRA: { SEMANTICS: { toString: null } } }],
  ];
  for (const [label, override] of malformed) {
    await t.test(label, async () => {
      await assert.rejects(
        mockedStageMetadata([{ ...processStage, ...override }]).snapshot(),
        /invalid crm stage (semantics|metadata)/i);
    });
  }
  const valid = await mockedStageMetadata([processStage]).snapshot();
  assert.equal(valid.counts.activeDeals, 1);
  assert.equal(valid.activeDealAmountRUB, 100.25);
});

test('invalid Bitrix SORT cannot turn a progressed lead into a new lead', async t => {
  const working = { ...processStage, STATUS_ID: 'IN_PROCESS', NAME: 'Working', SORT: 20 };
  for (const sort of [[], ['20'], 'not-a-number', '1e1', null,
                      Number.MAX_SAFE_INTEGER + 1]) {
    await t.test('SORT ' + JSON.stringify(sort), async () => {
      await assert.rejects(
        mockedStageMetadata([processStage, { ...working, SORT: sort }], 1).snapshot(),
        /invalid crm stage sort/i);
    });
  }
  for (const sort of [20, '20']) {
    const result = await mockedStageMetadata([processStage, { ...working, SORT: sort }], 1).snapshot();
    assert.equal(result.counts.newLeads, 0);
    assert.equal(result.counts.activeLeads, 1);
  }
});
