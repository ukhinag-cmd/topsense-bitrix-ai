'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// This adapter is dormant. All Bitrix traffic below is a caller-injected mock.
// A successful list total must not mask CRM records excluded by local filtering.
test('dormant Sales read-only adapter refuses out-of-filter CRM rows', async t => {
  const stage = {
    STATUS_ID: 'NEW', NAME: 'New', SORT: 10,
    EXTRA: { SEMANTICS: 'process' },
  };
  const row = {
    id: 7, title: 'Deal', stageId: 'NEW', categoryId: 0,
    assignedById: 9, opportunity: 1000, currencyId: 'RUB',
    createdTime: '2026-11-01T10:00:00+03:00',
    updatedTime: '2026-11-01T10:00:00+03:00',
  };
  function mock(type, item) {
    return async (method, params) => {
      if (method === 'crm.category.list')
        return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
      if (method === 'crm.status.list') {
        const isLead = params.filter.ENTITY_ID === 'STATUS';
        const rows = isLead === (type === 'lead') ? [stage] : [];
        return { result: rows, total: rows.length };
      }
      assert.equal(method, 'crm.item.list');
      assert.equal(params.entityTypeId, type === 'lead' ? 1 : 2);
      return { result: { items: [item] }, total: 1 };
    };
  }
  async function snapshot(type, item) {
    return createReadOnlySalesAdapter(mock(type, item))
      .snapshot(type === 'lead' ? { pipelineIds: [] } : {});
  }
  for (const [label, invalid] of [
    ['stage outside requested filter', { stageId: 'WON' }],
    ['missing stage', { stageId: null }],
    ['foreign deal pipeline', { categoryId: 1 }],
    ['absent deal pipeline', { categoryId: undefined }],
    ['null deal pipeline masquerading as zero', { categoryId: null }],
    ['array deal pipeline masquerading as zero', { categoryId: [0] }],
    ['noncanonical category ID', { categoryId: '00' }],
  ]) {
    await t.test(label + ' is rejected rather than undercounted', async () => {
      await assert.rejects(snapshot('deal', { ...row, ...invalid }),
        /requested (stage|pipeline) filter|invalid/i);
    });
  }
  for (const [label, invalid] of [
    ['lead outside requested stage', { stageId: 'QUALIFIED' }],
    ['lead stage missing', { stageId: null }],
  ]) {
    await t.test(label + ' is rejected rather than undercounted', async () => {
      await assert.rejects(snapshot('lead', { ...row, ...invalid }),
        /requested stage filter|invalid/i);
    });
  }
  await t.test('valid numeric string category 0 and stage still yield one deal', async () => {
    const result = await snapshot('deal', { ...row, categoryId: '0' });
    assert.equal(result.counts.activeDeals, 1);
    assert.equal(result.priorityQueue[0].key, 'deal:7');
  });
  await t.test('valid requested lead stage still yields one lead', async () => {
    const result = await snapshot('lead', row);
    assert.equal(result.counts.newLeads, 1);
    assert.equal(result.priorityQueue[0].key, 'lead:7');
  });
});
