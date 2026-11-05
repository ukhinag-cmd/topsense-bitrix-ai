'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadOnlySalesAdapter } = require('./sales-bitrix-readonly');

// Dormant adapter only: all Bitrix24 responses are injected in-memory.
// An absent currency is not a verified foreign currency. In particular,
// excluding that row from the RUB subtotal and calling it "non-RUB"
// can report a believable but incomplete Dashboard amount.
async function snapshot(rows) {
  return createReadOnlySalesAdapter(async (method, params) => {
    if (method === 'crm.category.list') {
      return { result: { categories: [{ id: 0, name: 'Main' }] }, total: 1 };
    }
    if (method === 'crm.status.list') {
      const stages = params.filter.ENTITY_ID === 'DEAL_STAGE'
        ? [{ STATUS_ID: 'NEW', NAME: 'Open', SORT: 10, SEMANTICS: null }] : [];
      return { result: stages, total: stages.length };
    }
    assert.equal(method, 'crm.item.list');
    assert.equal(params.entityTypeId, 2);
    return { result: { items: rows.map((fields, index) => ({
      id: index + 1, categoryId: 0, stageId: 'NEW', title: 'Mock deal',
      opportunity: '100.25', ...fields,
    })) }, total: rows.length };
  }).snapshot();
}

test('missing or blank deal currency cannot be mislabeled foreign or certify an incomplete RUB subtotal', async t => {
  for (const missing of [undefined, null, '   ']) {
    await t.test('currency ' + String(missing), async () => {
      const actual = await snapshot([
        { currencyId: 'RUB' },
        { currencyId: missing },
      ]);
      assert.equal(actual.counts.activeDeals, 2);
      assert.equal(actual.activeDealAmountRUB, null,
        'the unknown-currency amount could be RUB; a precise subtotal is unsafe');
      assert.equal(actual.nonRubDealCount, 0,
        'unknown currency must not be called verified non-RUB');
      assert.equal(actual.unknownCurrencyDealCount, 1);
    });
  }
});

test('known foreign currency is excluded, but verified zero without currency is monetary-neutral', async () => {
  const knownForeign = await snapshot([
    { currencyId: 'RUB' }, { currencyId: 'EUR' },
  ]);
  assert.equal(knownForeign.activeDealAmountRUB, 100.25);
  assert.equal(knownForeign.nonRubDealCount, 1);
  assert.equal(knownForeign.unknownCurrencyDealCount, 0);

  const zero = await snapshot([
    { currencyId: 'RUB' }, { currencyId: '', opportunity: '0.00' },
  ]);
  assert.equal(zero.activeDealAmountRUB, 100.25);
  assert.equal(zero.nonRubDealCount, 0);
  assert.equal(zero.unknownCurrencyDealCount, 0);
});
