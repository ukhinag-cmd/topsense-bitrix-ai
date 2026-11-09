'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored Sales score and alert audit rows reject reversed fractional timestamps', () => {
  // Use only the local hydration validator: no CRM, Sheets, Render or network.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;

  const earlier = new Date(Date.now() - 180000).toISOString();
  const observed = new Date(Date.now() - 120000).toISOString();
  // Both parse to exactly the same millisecond in JavaScript, but these
  // ordered four-digit fractional CRM instants are genuinely different.
  const first = observed.replace(/Z$/, '1Z');
  const second = observed.replace(/Z$/, '2Z');
  const history = at => ({
    at, stageId: 'NEW', amount: 0, currency: 'RUB',
    prospectScore: 30, riskScore: 45,
  });
  const alert = at => ({
    at, type: 'warning', title: 'Follow up', detail: 'Check next activity',
  });
  const base = {
    kind: 'salesDeal', dealId: '9995319', title: 'Fractional audit order',
    managerId: '', manager: '—', categoryId: '0',
    stageId: 'NEW', semantic: 'P', sourceStageSemantic: 'P', open: true,
    amount: 0, currency: 'RUB',
    updatedAt: observed, sourceUpdatedAt: earlier, createdAt: earlier,
    nextActivityAt: null, hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие',
    qualificationIssue: false, prospectScore: 30, riskScore: 45,
    scoreHistory: [history(first), history(second)],
    alerts: [alert(first), alert(second)],
  };

  assert.equal(validate(base), true,
    'chronological fractional audit history and alerts remain loadable');
  assert.equal(validate({
    ...base, scoreHistory: [history(second), history(first)]
  }), false,
  'the Sheet must not reverse score audit entries within one millisecond');
  assert.equal(validate({
    ...base, alerts: [alert(second), alert(first)]
  }), false,
  'the Sheet must not reverse alert history within one millisecond');
  assert.equal(validate({
    ...base, scoreHistory: [history(first), history(first)],
    alerts: [alert(first), alert(first)]
  }), true, 'same-time audit observations remain compatible');
});
