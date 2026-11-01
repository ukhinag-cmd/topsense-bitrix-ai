'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted Sales alerts must remain chronological before startup hydration', () => {
  // Exercise the production row validator with local data only, no CRM/Sheet requests.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const earlier = new Date(Date.now() - 180000).toISOString();
  const later = new Date(Date.now() - 120000).toISOString();
  const alert = (at, title) => ({ at, type: 'warning', title, detail: 'Проверить' });
  const base = {
    kind: 'salesDeal', dealId: '998401',
    title: 'Stored alert order', manager: 'Sales',
    stageId: 'NEW', semantic: 'P', open: true,
    amount: 0, currency: 'RUB',
    updatedAt: later, sourceUpdatedAt: earlier,
    nextStep: 'Назначить действие', hasNext: false,
    qualificationIssue: false, prospectScore: 30, riskScore: 45,
    scoreHistory: [],
    alerts: [alert(earlier, 'first'), alert(later, 'second')],
  };
  assert.equal(validate(base), true, 'ordered alerts are valid');
  assert.equal(validate({
    ...base, alerts: [alert(earlier, 'first'), alert(earlier, 'second')]
  }), true, 'same-time alerts can be emitted for one observation');
  assert.equal(validate({
    ...base, alerts: [alert(later, 'second'), alert(earlier, 'first')]
  }), false, 'reversed stored alert timeline must not be trusted');
});
