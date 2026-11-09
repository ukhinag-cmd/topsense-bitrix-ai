'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored Sales alerts must have an emitted, recognized notification type', () => {
  // Sheet history is untrusted. Run the startup validator locally, without
  // CRM, Sheet, Render, or email access.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const at = new Date(Date.now() - 60_000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9972413', title: 'Verified Sales notification',
    manager: 'Manager', managerId: '7', categoryId: '0', stageId: 'NEW',
    semantic: 'P', open: true, amount: 500000, currency: 'RUB',
    updatedAt: at, sourceUpdatedAt: at,
    nextStep: 'Назначить следующее действие', hasNext: false,
    nextOverdue: false, qualificationIssue: false,
    prospectScore: 75, riskScore: 55, scoreHistory: [], alerts: [],
  };
  const alert = type => ({
    at, type, title: 'Notification', detail: 'Review deal',
    titleDeal: base.title, manager: base.manager,
    amount: base.amount, currency: base.currency,
  });

  assert.equal(validate(base), true, 'ordinary stored row remains valid');
  for (const type of ['success', 'prospect', 'risk', 'warning']) {
    assert.equal(validate({ ...base, alerts: [alert(type)] }), true,
      'a notification type genuinely emitted by Sales survives restart: ' + type);
  }

  // The Dashboard formerly turned arbitrary type strings into a generic
  // warning. A corrupted Sheet could thus inject a fabricated audit alert.
  for (const type of ['', 'critical', 'WARNING', '__proto__']) {
    assert.equal(validate({ ...base, alerts: [alert(type)] }), false,
      'unknown stored notification type must not be trusted: ' + type);
  }
});
