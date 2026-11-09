'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Bitrix uses the year-9999 activity deadline as "not scheduled". Live
// crm.deal.get normalizes it away. A restored Sheet row must not reintroduce
// this sentinel as a verified future Next Step or an inflated Prospect Score.
test('stored Bitrix no-deadline sentinels are not valid scheduled actions', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const observed = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '998520', title: 'Unscheduled sentinel',
    manager: 'Sales', stageId: 'NEW', semantic: 'P', open: true,
    amount: 0, currency: 'RUB',
    updatedAt: observed, sourceUpdatedAt: observed,
    nextActivityAt: future, hasNext: true, nextOverdue: false,
    nextStep: 'Следующее действие запланировано', qualificationIssue: false,
    prospectScore: 30, riskScore: 25, scoreHistory: [], alerts: [],
  };
  assert.equal(validate(base), true, 'a genuine upcoming action remains valid');

  for (const sentinel of [
    '9999-12-31T00:00:00+03:00',
    '9999-12-30T00:00:00Z',
    '9999-12-31T23:59:59Z',
  ]) {
    assert.equal(validate({ ...base, nextActivityAt: sentinel }), false,
      'unplanned Bitrix deadline must not become a planned Next Step: ' + sentinel);
  }
  assert.equal(validate({
    ...base, nextActivityAt: null, hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие',
  }), true, 'a genuinely absent Next Step remains loadable');
});
