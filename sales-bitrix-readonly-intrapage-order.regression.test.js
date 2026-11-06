'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// This adapter is dormant. These in-memory responses simulate a Bitrix
// createdTime DESC, id DESC offset scan; they never contact a real portal.
const deal = (id, createdTime) => ({
  id, title: 'Deal ' + id, categoryId: 0, stageId: 'NEW',
  assignedById: 3, createdTime, updatedTime: '2026-11-06T09:00:00+03:00',
  currencyId: 'RUB', opportunity: '100.00',
});

function adapterFor(firstRows) {
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
    assert.deepEqual(params.order, { createdTime: 'DESC', id: 'DESC' });
    starts.push(params.start);
    if (params.start === 0)
      return { result: { items: firstRows }, total: 3, next: 2 };
    assert.equal(params.start, 2);
    return { result: { items: [deal(100, '2026-11-01T09:00:00+03:00')] }, total: 3 };
  };
  return { adapter: createReadOnlySalesAdapter(request), starts };
}

test('paginated CRM item scan rejects a reversed pair inside the first page', async () => {
  const { adapter } = adapterFor([
    deal(101, '2026-11-03T09:00:00+03:00'),
    deal(102, '2026-11-05T09:00:00+03:00'),
  ]);
  await assert.rejects(adapter.snapshot(), /out.of.order|pagination|sort/i);
});

test('paginated CRM item scan rejects reversed IDs at a fractional timestamp tie', async () => {
  const { adapter } = adapterFor([
    deal(101, '2026-11-05T09:00:00.123456+03:00'),
    deal(102, '2026-11-05T09:00:00.123456+03:00'),
  ]);
  await assert.rejects(adapter.snapshot(), /out.of.order|pagination|sort/i);
});

test('legitimate descending rows inside a paginated CRM item scan still work', async () => {
  const { adapter, starts } = adapterFor([
    deal(102, '2026-11-05T09:00:00.123456+03:00'),
    deal(101, '2026-11-05T09:00:00.123456+03:00'),
  ]);
  const snapshot = await adapter.snapshot();
  assert.equal(snapshot.counts.activeDeals, 3);
  assert.deepEqual(starts, [0, 2]);
});
