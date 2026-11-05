'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Inert preparation adapter: injected in-memory CRM responses only, never a
// real portal or writable transport. A manager alias distorts ownership.
function withManager(assignedById, entityTypeId) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const want = entityTypeId === 1 ? 'STATUS' : 'DEAL_STAGE';
      const stages = params.filter.ENTITY_ID === want
        ? [{ STATUS_ID: 'NEW', NAME: 'New', SORT: 10,
             EXTRA: { SEMANTICS: 'process' } }] : [];
      return { result: stages, total: stages.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, entityTypeId);
    return { result: { items: [{ id: 7, stageId: 'NEW', categoryId: 0,
      assignedById, currencyId: 'RUB', opportunity: '100.25' }] }, total: 1 };
  });
}

test('read-only adapter rejects noncanonical and nonscalar manager identity aliases', async t => {
  for (const entityTypeId of [1, 2]) {
    for (const assignedById of [
      ['9'], ['9', '10'], { toString: null }, true,
      '09', '9e0', ' 9 ', '9007199254740992',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await t.test('entity ' + entityTypeId + ', manager ' + JSON.stringify(assignedById),
        async () => {
          await assert.rejects(withManager(assignedById, entityTypeId).snapshot(),
            /invalid crm item manager identity/i);
        });
    }
  }
});

test('read-only adapter preserves legitimate assigned and unassigned managers', async t => {
  for (const entityTypeId of [1, 2]) {
    for (const [assignedById, expected] of [
      [9, '9'], ['9', '9'], [0, '0'], ['0', '0'],
      [null, null], ['', null],
    ]) {
      await t.test('entity ' + entityTypeId + ', manager ' + JSON.stringify(assignedById),
        async () => {
          const s = await withManager(assignedById, entityTypeId).snapshot();
          assert.equal(s.counts.queue, 1);
          assert.equal(s.priorityQueue[0].managerId, expected);
        });
    }
  }
});
