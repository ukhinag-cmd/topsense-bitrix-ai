'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');
const { probeDealNextActivity } = require('./sales-activity-readonly');

// In-memory provider responses only. Real JSON object properties are
// enumerable; a transport object must not hide pagination metadata while
// a defensive copy silently drops it and certifies a partial CRM scan.
function hidden(object, key, value) {
  Object.defineProperty(object, key, {
    value, enumerable: false, configurable: true, writable: true,
  });
  return object;
}

test('read-only lead snapshot never drops a non-enumerable total and certifies an incomplete count', async () => {
  const read = createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list') {
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    }
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'STATUS'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }]
        : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    return hidden({
      result: { items: [{ id: 7, stageId: 'NEW', title: 'Lead' }] },
    }, 'total', 2);
  });
  await assert.rejects(read.snapshot({ pipelineIds: [] }),
    /crm read failed|invalid crm response|pagination|total/i);
});

test('read-only Next Step probe never drops hidden total or next cursor', async () => {
  const activity = {
    ID: '10421', OWNER_TYPE_ID: '2', OWNER_ID: '72', COMPLETED: 'N',
    DEADLINE: '2026-11-07T09:30:00+03:00',
  };
  for (const [key, value] of [['total', 2], ['next', 1]]) {
    await assert.rejects(
      probeDealNextActivity(async () =>
        hidden({ result: [activity] }, key, value), 72),
      /bitrix activity read failed|invalid bitrix activity response|pagination|scan|total/i,
      'reject hidden ' + key + ' instead of treating a partial activity list as complete',
    );
  }
});

test('ordinary enumerable read-only result metadata remains supported', async () => {
  const result = await probeDealNextActivity(async () => ({
    result: [{
      ID: '10421', OWNER_TYPE_ID: '2', OWNER_ID: '72',
      COMPLETED: 'N', DEADLINE: '2026-11-07T09:30:00+03:00',
    }],
    total: 1,
  }), 72);
  assert.equal(result.checked, 1);
  assert.equal(result.nextActivityAt, '2026-11-07T06:30:00.000Z');
});
