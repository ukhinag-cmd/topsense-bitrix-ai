'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeDealNextActivity } = require('./sales-activity-readonly');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// No live CRM requests: malformed arrays are returned only by injected
// transports. A missing array index is NOT an empty result: accepting it
// would certify a false "no next step"/zero-lead dashboard snapshot.
test('Next Step probe rejects a sparse Bitrix activity page instead of reporting no activity', async () => {
  const missing = new Array(1);
  await assert.rejects(
    probeDealNextActivity(async () => ({ result: missing }), 72),
    /invalid|sparse|activity/i,
  );
});

test('read-only Sales Dashboard rejects a sparse CRM item page instead of undercounting', async () => {
  const missing = new Array(1);
  const request = async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list')
      return { result: params.filter.ENTITY_ID === 'STATUS'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }] : [], total: params.filter.ENTITY_ID === 'STATUS' ? 1 : 0 };
    assert.equal(method, 'crm.item.list');
    return { result: { items: missing } };
  };
  await assert.rejects(
    createReadOnlySalesAdapter(request).snapshot({ pipelineIds: [] }),
    /invalid|sparse|CRM/i,
  );
});

test('dense CRM arrays, including explicitly empty pages, retain normal behavior', async () => {
  const activity = { ID: 101, OWNER_TYPE_ID: 2, OWNER_ID: 72,
    COMPLETED: 'N', DEADLINE: '2026-11-07T09:30:00+03:00' };
  assert.equal((await probeDealNextActivity(async () => ({ result: [activity], total: 1 }), 72))
    .nextActivityAt, '2026-11-07T06:30:00.000Z');
  assert.equal((await probeDealNextActivity(async () => ({ result: [], total: 0 }), 72))
    .checked, 0);
});
