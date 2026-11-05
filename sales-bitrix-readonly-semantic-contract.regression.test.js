'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// No network or credentials: inject only in-memory Bitrix24 REST responses.
// Stage semantics are part of the snapshot's filter contract. Unknown or
// contradictory values must not make a live deal disappear from the queue.
const processStage = {
  STATUS_ID: 'NEW', NAME: 'New', SORT: 10, SEMANTICS: null,
  EXTRA: { SEMANTICS: 'process' },
};
function adapterFor(stage) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list')
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    if (method === 'crm.status.list') {
      const rows = params.filter.ENTITY_ID === 'DEAL_STAGE' ? [stage] : [];
      return { result: rows, total: rows.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return { result: { items: [{
      id: 9, stageId: 'NEW', categoryId: 0, title: 'Live deal',
      assignedById: 3, currencyId: 'RUB', opportunity: '125.25',
    }] }, total: 1 };
  });
}

test('unknown stage semantic values reject the snapshot instead of hiding active CRM records', async t => {
  for (const [label, stage] of [
    ['unknown short semantics', { ...processStage, SEMANTICS: 'P' }],
    ['unknown extra semantics', { ...processStage, EXTRA: { SEMANTICS: 'processing' } }],
    ['empty extra semantic', { ...processStage, EXTRA: { SEMANTICS: '' } }],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(adapterFor(stage).snapshot(), /invalid crm stage semantics/i);
    });
  }
});

test('contradictory stage semantic fields reject an untrustworthy snapshot', async t => {
  for (const [short, long] of [
    ['S', 'process'], ['F', 'success'], [null, 'failure'], ['S', 'failure'],
  ]) {
    await t.test(String(short) + '/' + long, async () => {
      await assert.rejects(
        adapterFor({ ...processStage, SEMANTICS: short, EXTRA: { SEMANTICS: long } }).snapshot(),
        /invalid crm stage semantics/i,
      );
    });
  }
});

test('documented Bitrix process, success, failure and apology semantics remain accepted', async () => {
  const process = await adapterFor(processStage).snapshot();
  assert.equal(process.counts.activeDeals, 1);
  assert.equal(process.activeDealAmountRUB, 125.25);

  for (const [short, long] of [
    ['S', 'success'], ['F', 'failure'], ['F', 'apology'],
  ]) {
    const result = await adapterFor({
      ...processStage, SEMANTICS: short, EXTRA: { SEMANTICS: long },
    }).snapshot();
    assert.equal(result.counts.activeDeals, 0);
    assert.equal(result.activeDealAmountRUB, 0);
  }
});
