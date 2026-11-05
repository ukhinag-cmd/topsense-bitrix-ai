'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Dormant preparation adapter. All responses are injected in memory:
// no Bitrix credentials, external REST calls or production deployments.
function adapterFor(semantic, extra) {
  const stage = statusId => ({
    STATUS_ID: statusId,
    NAME: 'In CRM',
    SORT: 10,
    ...(semantic === undefined ? {} : { SEMANTICS: semantic }),
    ...(extra === undefined ? {} : { EXTRA: extra }),
  });
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list') {
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    }
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'STATUS' ? [stage('NEW')] :
        params.filter.ENTITY_ID === 'DEAL_STAGE' ? [stage('NEW')] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    const lead = params.entityTypeId === 1;
    return { result: { items: [{
      id: lead ? 11 : 21,
      title: lead ? 'New lead' : 'Active deal',
      stageId: 'NEW',
      ...(lead ? {} : { categoryId: 0 }),
      assignedById: 7,
      currencyId: 'RUB',
      opportunity: '125.50',
    }] }, total: 1 };
  });
}

test('Bitrix short SEMANTICS null denotes an active stage even if EXTRA is absent or empty', async t => {
  for (const extra of [undefined, {}]) {
    await t.test(extra === undefined ? 'EXTRA absent' : 'EXTRA empty', async () => {
      const snapshot = await adapterFor(null, extra).snapshot();
      assert.equal(snapshot.counts.newLeads, 1, 'new lead must remain visible');
      assert.equal(snapshot.counts.activeDeals, 1, 'open deal must remain visible');
      assert.equal(snapshot.counts.queue, 2);
      assert.equal(snapshot.activeDealAmountRUB, 125.5);
    });
  }
});

test('explicit closed short semantics remain closed without EXTRA', async () => {
  for (const semantic of ['S', 'F']) {
    const snapshot = await adapterFor(semantic).snapshot();
    assert.equal(snapshot.counts.newLeads, 0);
    assert.equal(snapshot.counts.activeDeals, 0);
    assert.equal(snapshot.activeDealAmountRUB, 0);
  }
});

test('unknown semantics without either field are not silently assumed active', async () => {
  const snapshot = await adapterFor(undefined).snapshot();
  assert.equal(snapshot.counts.queue, 0);
});
