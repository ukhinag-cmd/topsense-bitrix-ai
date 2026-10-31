'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted alerts are validated even when a Sales snapshot has no score history', () => {
  // Exercise the startup validator without any Bitrix, Sheet, or Render request.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;

  const recent = new Date(Date.now() - 60000).toISOString();
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9914450',
    title: 'Stored alert validation', manager: 'Manager',
    stageId: 'NEW', semantic: 'P', open: true, amount: 250000,
    currency: 'RUB', updatedAt: recent, sourceUpdatedAt: recent,
    nextStep: 'Назначить действие', hasNext: false,
    qualificationIssue: false, prospectScore: 70, riskScore: 30,
    scoreHistory: [],
    alerts: [],
  };
  const alert = {
    at: recent, type: 'risk', title: 'Deal risk', detail: 'Attention needed',
  };

  assert.equal(validate(base), true, 'empty legitimate histories are allowed');
  assert.equal(validate({ ...base, alerts: [alert] }), true,
    'a valid alert is allowed even with an empty score timeline');
  assert.equal(validate({ ...base, alerts: [null] }), false,
    'a null alert must not enter Dashboard rendering');
  assert.equal(validate({ ...base, alerts: [{ ...alert, at: future }] }), false,
    'future-dated alerts must not suppress subsequent warnings');
  assert.equal(validate({ ...base, alerts: [{ ...alert, at: { toString: null } }] }), false,
    'untrusted alert date objects must not crash sorting or HTML rendering');
});
