'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// This adapter is dormant and accepts only an injected, in-memory transport.
// A stable total and unique CRM IDs do not protect an offset scan when the
// createdTime DESC, id DESC order drifts between pages.
function mockItemPages(first, second) {
  const starts = [];
  const request = async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    assert.deepEqual(params.order, { createdTime: 'DESC', id: 'DESC' });
    starts.push(params.start);
    const entry = params.start === 0 ? first : second;
    assert.ok(params.start === 0 || params.start === 1);
    return {
      result: { items: [{
        id: entry.id, title: 'Deal ' + entry.id,
        categoryId: 0, stageId: 'NEW', assignedById: 3,
        createdTime: entry.createdTime, updatedTime: '2026-11-06T10:00:00+03:00',
        currencyId: 'RUB', opportunity: '100.00',
      }] },
      ...(params.start === 0 ? { next: 1 } : {}),
      total: 2,
    };
  };
  return { adapter: createReadOnlySalesAdapter(request), starts };
}

test('read-only item pagination rejects a newer unique deal on a later offset page', async () => {
  const { adapter, starts } = mockItemPages(
    { id: 9101, createdTime: '2026-11-04T09:00:00+03:00' },
    { id: 9102, createdTime: '2026-11-05T09:00:00+03:00' }
  );
  await assert.rejects(adapter.snapshot(), /out.of.order|pagination|sort/i);
  assert.deepEqual(starts, [0, 1]);
});

test('read-only item pagination rejects reversed ID order on equal creation timestamps', async () => {
  const { adapter } = mockItemPages(
    { id: 9101, createdTime: '2026-11-05T09:00:00.123456+03:00' },
    { id: 9102, createdTime: '2026-11-05T09:00:00.123456+03:00' }
  );
  await assert.rejects(adapter.snapshot(), /out.of.order|pagination|sort/i);
});

test('descending createdTime and ID remain valid across offset pages', async () => {
  const { adapter, starts } = mockItemPages(
    { id: 9102, createdTime: '2026-11-05T09:00:00+03:00' },
    { id: 9101, createdTime: '2026-11-04T09:00:00+03:00' }
  );
  const result = await adapter.snapshot();
  assert.deepEqual(starts, [0, 1]);
  assert.equal(result.counts.activeDeals, 2);
  assert.deepEqual(result.priorityQueue.map(row => row.key).sort(), ['deal:9101', 'deal:9102']);
});
