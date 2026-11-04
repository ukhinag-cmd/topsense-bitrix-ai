'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// A Bitrix offset scan can drift if records are inserted or removed during
// pagination. A stable total and valid 50-row cursors do not prove that every
// distinct CRM record was observed. The adapter must fail closed, not silently
// de-duplicate a partial snapshot and give it authoritative queue counts.
test('dormant read-only snapshot rejects duplicate deal IDs across paginated CRM reads', async () => {
  const deal = id => ({
    id, title: 'Deal ' + id, categoryId: 0, stageId: 'NEW',
    createdTime: '2026-11-01T10:00:00+03:00',
    updatedTime: '2026-11-01T10:00:00+03:00',
    opportunity: 1000, currencyId: 'RUB', assignedById: 7,
  });
  const request = async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      if (params.filter.ENTITY_ID === 'STATUS')
        return { result: [], total: 0 };
      return { result: [{
        STATUS_ID: 'NEW', NAME: 'New', SORT: 10, EXTRA: { SEMANTICS: 'process' },
      }], total: 1 };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return params.start === 0
      ? { result: { items: Array.from({ length: 50 }, (_, i) => deal(i + 1)) },
          next: 50, total: 51 }
      : { result: { items: [deal(50)] }, total: 51 };
  };

  await assert.rejects(
    createReadOnlySalesAdapter(request).snapshot(),
    /duplicate|identity|inconsistent|pagination/i,
    'a repeated ID must not hide a missing 51st deal from the dashboard'
  );
});

test('dormant read-only snapshot rejects duplicate pipeline IDs in list results', async () => {
  const request = async method => {
    assert.equal(method, 'crm.category.list');
    return {
      result: { categories: [
        { id: 0, name: 'Main' },
        { id: 0, name: 'Contradictory duplicate' },
      ] },
      total: 2,
    };
  };
  await assert.rejects(
    createReadOnlySalesAdapter(request).snapshot({ pipelineIds: [] }),
    /duplicate|identity|inconsistent|pagination/i
  );
});


test('dormant read-only snapshot rejects missing and unusable CRM row identities', async t => {
  const deal = {
    id: 7, title: 'Checked deal', categoryId: 0, stageId: 'NEW',
    createdTime: '2026-11-01T10:00:00+03:00',
    updatedTime: '2026-11-01T10:00:00+03:00',
    opportunity: 1200, currencyId: 'RUB', assignedById: 7,
  };
  const stage = {
    STATUS_ID: 'NEW', NAME: 'New', SORT: 10,
    EXTRA: { SEMANTICS: 'process' },
  };
  const requestFor = (item, stageRow = stage) => async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list')
      return params.filter.ENTITY_ID === 'STATUS'
        ? { result: [], total: 0 }
        : { result: [stageRow], total: 1 };
    assert.equal(method, 'crm.item.list');
    return { result: { items: [item] }, total: 1 };
  };

  for (const [label, invalidId] of [['missing', undefined], ['null', null], ['zero', 0]]) {
    await t.test('item ID ' + label + ' does not silently disappear', async () => {
      const row = { ...deal, id: invalidId };
      await assert.rejects(
        createReadOnlySalesAdapter(requestFor(row)).snapshot(),
        /missing|invalid.*identity/i,
      );
    });
  }
  for (const [label, invalidStatus] of [['missing', undefined], ['empty', '']]) {
    await t.test('stage STATUS_ID ' + label + ' cannot hide in-progress deals', async () => {
      await assert.rejects(
        createReadOnlySalesAdapter(requestFor(deal, { ...stage, STATUS_ID: invalidStatus })).snapshot(),
        /missing|invalid.*identity/i,
      );
    });
  }
  await t.test('valid default pipeline, status and deal IDs still form a queue', async () => {
    const snapshot = await createReadOnlySalesAdapter(requestFor(deal)).snapshot();
    assert.equal(snapshot.counts.activeDeals, 1);
    assert.equal(snapshot.priorityQueue[0].key, 'deal:7');
  });
});
