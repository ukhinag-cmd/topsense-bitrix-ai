'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// All CRM requests use injected memory-only fixtures. This dormant adapter
// cannot contact Bitrix24, Google Sheets, Render or production services.
function adapterFor(overrides = {}) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null }] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return { result: { items: [{
      id: 7, title: 'Opportunity', stageId: 'NEW', categoryId: 0,
      assignedById: 3, opportunity: '1200.50', currencyId: 'RUB',
      createdTime: '2026-11-05T09:00:00+03:00',
      updatedTime: '2026-11-05T10:00:00+03:00',
      ...overrides,
    }] }, total: 1 };
  });
}

test('malformed CRM timestamps must not silently become missing queue/history dates', async t => {
  for (const [field, value] of [
    ['createdTime', ['2026-11-05T09:00:00+03:00']],
    ['updatedTime', { toString: null }],
    ['createdTime', 1793869200],
    ['updatedTime', false],
    ['createdTime', 'not-a-date'],
    ['updatedTime', '2026'],
    // ISO without a timezone is interpreted in the *host* timezone and can
    // reorder Sales history across UTC/Moscow/CI hosts. Bitrix timestamps
    // used for provenance must encode an explicit offset or UTC Z.
    ['createdTime', '2026-11-05T09:00:00'],
    ['updatedTime', '2026-11-05T09:00:00.123'],
    // JS Date.parse accepts offsets beyond any real civil timezone, while
    // the read-only activity adapter already rejects them. Such timestamps
    // can fabricate chronology for a seemingly healthy Sales snapshot.
    ['createdTime', '2026-11-05T09:00:00+15:00'],
    ['updatedTime', '2026-11-05T09:00:00-23:59'],
    ['createdTime', '2026-11-05T09:00:00+14:30'],
  ]) {
    await t.test(field + ': ' + JSON.stringify(value), async () => {
      await assert.rejects(adapterFor({ [field]: value }).snapshot(),
        /invalid crm item (created|updated) time/i);
    });
  }
});

test('valid Bitrix ISO timestamps and explicitly absent dates remain compatible', async () => {
  const valid = await adapterFor().snapshot();
  assert.equal(valid.counts.activeDeals, 1);
  assert.equal(valid.priorityQueue[0].createdAt, '2026-11-05T09:00:00+03:00');
  assert.equal(valid.priorityQueue[0].updatedAt, '2026-11-05T10:00:00+03:00');
  const legacy = await adapterFor({ createdTime: null, updatedTime: undefined }).snapshot();
  assert.equal(legacy.counts.activeDeals, 1);
  assert.equal(legacy.priorityQueue[0].createdAt, null);
  assert.equal(legacy.priorityQueue[0].updatedAt, null);
});

test('updatedTime must not precede createdTime in a trusted CRM snapshot', async () => {
  await assert.rejects(
    adapterFor({
      createdTime: '2026-11-06T09:00:00+03:00',
      updatedTime: '2026-11-05T10:00:00+03:00',
    }).snapshot(),
    /invalid crm item chronology/i
  );
  // Compare instants rather than lexical timestamps: different valid offsets
  // may encode the same UTC instant. Missing dates remain optional.
  const equalInstant = await adapterFor({
    createdTime: '2026-11-05T09:00:00+03:00',
    updatedTime: '2026-11-05T06:00:00Z',
  }).snapshot();
  assert.equal(equalInstant.counts.activeDeals, 1);
  const missing = await adapterFor({ createdTime: null }).snapshot();
  assert.equal(missing.counts.activeDeals, 1);
});

test('real boundary timezone offsets remain supported', async () => {
  const snapshot = await adapterFor({
    createdTime: '2026-11-04T00:00:00+14:00',
    updatedTime: '2026-11-04T23:59:59-12:00',
  }).snapshot();
  assert.equal(snapshot.counts.activeDeals, 1);
});
