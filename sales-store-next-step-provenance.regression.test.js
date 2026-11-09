'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A persisted Next Step is an untrusted Sheet observation, not a CRM fact.
// Only the scored activity timestamp can justify "scheduled" or "overdue".
test('stored Next Step flags must agree with activity timestamp provenance', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const now = Date.now();
  const observed = new Date(now - 60_000).toISOString();
  const scheduled = new Date(now + 86_400_000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9971428', title: 'Activity provenance check',
    manager: 'Manager', managerId: '7', categoryId: '0', stageId: 'NEW',
    semantic: 'P', sourceStageSemantic: 'P', stageSemanticKnown: true, open: true,
    amount: 300000, currency: 'RUB',
    createdAt: new Date(now - 2 * 86_400_000).toISOString(),
    updatedAt: observed, sourceUpdatedAt: observed,
    nextActivityAt: scheduled, hasNext: true, nextOverdue: false,
    nextStep: 'Следующее действие запланировано',
    qualificationIssue: false, prospectScore: 75, riskScore: 20,
    scoreHistory: [], alerts: [],
  };
  assert.equal(validate(base), true, 'real scheduled Next Step remains loadable');
  assert.equal(validate({ ...base, nextActivityAt: null }), false,
    'a missing activity date cannot certify a scheduled Next Step');
  assert.equal(validate({ ...base, nextOverdue: true }), false,
    'the same activity cannot be both upcoming and overdue');

  const overdue = {
    ...base, nextActivityAt: new Date(now - 86_400_000).toISOString(),
    hasNext: false, nextOverdue: true,
    nextStep: 'Просрочено следующее действие — перепланировать',
  };
  assert.equal(validate(overdue), true, 'real overdue Next Step remains loadable');
  assert.equal(validate({ ...overdue, nextActivityAt: null }), false,
    'an overdue flag without an activity date is fabricated');

  assert.equal(validate({
    ...base, nextActivityAt: null, hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие',
  }), true, 'legitimate missing-next-action history remains compatible');
});
