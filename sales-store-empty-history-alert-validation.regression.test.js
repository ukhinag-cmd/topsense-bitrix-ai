'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted alerts are validated even when historical score observations are empty', () => {
  // This is an isolated, offline validation check of an untrusted Sheet row.
  // In particular, Array#every on scoreHistory=[] must not bypass alerts.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;
  const earlier = new Date(Date.now() - 120000).toISOString();
  const later = new Date(Date.now() - 60000).toISOString();
  const good = { at: later, type: 'warning', title: 'Проверить', detail: 'Есть риск' };
  const row = {
    kind: 'salesDeal', dealId: '9965512', title: 'Alert audit',
    manager: 'Manager', categoryId: '0', stageId: 'NEW',
    semantic: 'P', sourceStageSemantic: 'P', stageSemanticKnown: true,
    open: true, amount: 0, currency: 'RUB', updatedAt: later,
    sourceUpdatedAt: later, nextStep: 'Назначить действие',
    hasNext: false, qualificationIssue: false, prospectScore: 10, riskScore: 30,
    scoreHistory: [], alerts: [good],
  };
  assert.equal(validate(row), true, 'valid legacy empty history with an alert is accepted');
  assert.equal(validate({ ...row, alerts: [] }), true, 'empty alert/history arrays are accepted');

  for (const invalid of [
    [null],
    [{ ...good, title: { injected: 'object' } }],
    [{ ...good, detail: ['not a scalar'] }],
    [{ ...good, at: 'not a date' }],
    [{ ...good, at: new Date(Date.now() + 86400000).toISOString() }],
    [{ ...good, type: null }],
    [{ ...good }, { ...good, at: earlier }],
  ]) {
    assert.equal(validate({ ...row, alerts: invalid }), false,
      'untrusted malformed or out-of-order alerts cannot bypass validation via empty history');
  }
});
