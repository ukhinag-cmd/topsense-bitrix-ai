'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Bitrix deal title, source and pipeline category must be scalar before Sales stores them', () => {
  // Read the same validator that guards both crm.deal.get events and
  // crm.deal.list pages, without invoking any real REST or Sheet transport.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validateDealRow = validateDealRow;',
    context, { filename: 'sales.js' }
  );
  const validateDealRow = context.module.exports.__validateDealRow;

  const deal = {
    ID: '9920410',
    TITLE: 'Verified deal',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: 0,
    STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000',
    CURRENCY_ID: 'RUB',
    DATE_MODIFY: new Date(Date.now() - 60000).toISOString(),
  };
  assert.equal(validateDealRow(deal), deal);
  assert.equal(validateDealRow({ ...deal, CATEGORY_ID: '0' }).CATEGORY_ID, '0');
  assert.equal(validateDealRow({
    ...deal, TITLE: false, SOURCE_ID: false, CATEGORY_ID: false,
  }).ID, deal.ID, 'Bitrix empty-field sentinels remain supported');

  // Previously String(array) made a malformed source/category/title appear
  // trustworthy, and a nested value could be persisted as real deal metadata.
  const malformed = [
    { TITLE: ['Verified deal'] },
    { TITLE: { value: 'Verified deal' } },
    { TITLE: 7 },
    { SOURCE_ID: ['WEB'] },
    { SOURCE_ID: { value: 'WEB' } },
    { SOURCE_ID: 9 },
    { CATEGORY_ID: ['0'] },
    { CATEGORY_ID: { id: 0 } },
    { CATEGORY_ID: true },
    { CATEGORY_ID: -1 },
    { CATEGORY_ID: '0x10' },
    { CATEGORY_ID: '00' },
  ];
  for (const patch of malformed) {
    const field = Object.keys(patch)[0];
    assert.throws(
      () => validateDealRow({ ...deal, ...patch }),
      new RegExp('Invalid Bitrix deal ' + field),
      field + ' must not be coerced into trusted Dashboard metadata'
    );
  }
});
