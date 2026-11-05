'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Mocked Bitrix24 responses only. A deal can change pipelines while two
// separate read-only scans are running. Each individual page can satisfy its
// filter and total while the same deal is returned in both pipelines.
function mockCrossPipelineRead(secondId) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'crm.category.list')
      return { result: { categories: [
        { id: 0, name: 'Main' }, { id: 1, name: 'Other' },
      ] }, total: 2 };
    if (method === 'crm.status.list') {
      if (params.filter.ENTITY_ID === 'STATUS')
        return { result: [], total: 0 };
      return { result: [{
        STATUS_ID: params.filter.ENTITY_ID === 'DEAL_STAGE' ? 'NEW' : 'C1:NEW',
        NAME: 'In progress', SORT: 10, EXTRA: { SEMANTICS: 'process' },
      }], total: 1 };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    const categoryId = params.filter.categoryId;
    return { result: { items: [{
      id: categoryId === 0 ? 42 : secondId,
      title: 'Deal in pipeline ' + categoryId,
      categoryId,
      stageId: categoryId === 0 ? 'NEW' : 'C1:NEW',
      createdTime: '2026-11-01T10:00:00+03:00',
      updatedTime: '2026-11-01T10:00:00+03:00',
      currencyId: 'RUB', opportunity: '100.25',
    }] }, total: 1 };
  };
  return { adapter: createReadOnlySalesAdapter(request), calls };
}

test('read-only adapter rejects one deal observed under two pipelines', async () => {
  const { adapter } = mockCrossPipelineRead(42);
  await assert.rejects(adapter.snapshot(),
    /duplicate|inconsistent|identity/i,
    'cross-pipeline duplicates must not be silently de-duplicated into a trusted count');
});

test('distinct deal IDs across pipelines remain visible', async () => {
  const { adapter } = mockCrossPipelineRead(43);
  const result = await adapter.snapshot();
  assert.equal(result.counts.activeDeals, 2);
  assert.equal(result.activeDealAmountRUB, 200.5);
  assert.deepEqual(result.priorityQueue.map(row => row.key).sort(),
    ['deal:42', 'deal:43']);
});

test('scanning only one selected pipeline remains valid', async () => {
  const { adapter, calls } = mockCrossPipelineRead(42);
  const result = await adapter.snapshot({ pipelineIds: [0] });
  assert.equal(result.counts.activeDeals, 1);
  assert.equal(result.priorityQueue[0].key, 'deal:42');
  assert.equal(calls.filter(call =>
    call.method === 'crm.item.list' && call.params.filter.categoryId === 1).length, 0);
});
