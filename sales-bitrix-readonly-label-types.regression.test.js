'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Inert, injected-response adapter only. Display labels from untrusted CRM
// JSON must not be stringified from arrays/objects into believable labels.
function adapterFor({ categoryName = 'Main', stageName = 'Working', title = 'Checked deal' } = {}) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: categoryName }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: stageName, SORT: 10,
             EXTRA: { SEMANTICS: 'process' } }] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return { result: { items: [{
      id: 7, title, categoryId: 0, stageId: 'NEW',
      assignedById: 9, currencyId: 'RUB', opportunity: '100.25',
    }] }, total: 1 };
  });
}

test('read-only CRM labels reject non-scalar metadata rather than displaying fabricated strings', async t => {
  const cases = [
    ['category array', { categoryName: ['Main'] }, /invalid crm pipeline label/i],
    ['category object', { categoryName: { toString: null } }, /invalid crm pipeline label/i],
    ['stage array', { stageName: ['Working'] }, /invalid crm stage label/i],
    ['stage number', { stageName: 123 }, /invalid crm stage label/i],
    ['deal title array', { title: ['Checked deal'] }, /invalid crm item title/i],
    ['deal title object', { title: { toString: null } }, /invalid crm item title/i],
    ['deal title boolean', { title: false }, /invalid crm item title/i],
  ];
  for (const [label, input, error] of cases) {
    await t.test(label, async () => {
      await assert.rejects(adapterFor(input).snapshot(), error);
    });
  }
});

test('valid strings and absent optional CRM labels remain compatible', async () => {
  const normal = await adapterFor().snapshot();
  assert.equal(normal.counts.activeDeals, 1);
  assert.equal(normal.priorityQueue[0].title, 'Checked deal');
  assert.equal(normal.priorityQueue[0].stageName, 'Working');
  assert.equal(normal.funnels[0].name, 'Main');
  assert.equal(normal.activeDealAmountRUB, 100.25);

  const missing = await adapterFor({
    categoryName: null, stageName: null, title: null,
  }).snapshot();
  assert.equal(missing.counts.activeDeals, 1);
  assert.equal(missing.priorityQueue[0].title, '');
  assert.equal(missing.priorityQueue[0].stageName, '');
  assert.equal(missing.funnels[0].name, 'Без названия');
});
