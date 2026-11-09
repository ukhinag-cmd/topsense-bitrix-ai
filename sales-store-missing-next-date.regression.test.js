'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A Sheet row may omit a formerly optional field entirely. Missing activity
// provenance must not certify a scheduled or overdue Next Step after restart.
test('missing stored activity timestamp cannot substantiate Next Step flags', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const now = Date.now();
  const observed = new Date(now - 60000).toISOString();
  const scheduled = new Date(now + 86400000).toISOString();
  const row = {
    kind: 'salesDeal', dealId: '998519', title: 'Missing activity date',
    manager: 'Sales', stageId: 'NEW', semantic: 'P', open: true,
    amount: 0, currency: 'RUB', updatedAt: observed, sourceUpdatedAt: observed,
    nextStep: 'Следующее действие запланировано', hasNext: true, nextOverdue: false,
    nextActivityAt: scheduled, qualificationIssue: false,
    prospectScore: 30, riskScore: 10, scoreHistory: [], alerts: [],
  };
  assert.equal(validate(row), true, 'a valid scheduled snapshot must still load');

  const withoutDate = { ...row };
  delete withoutDate.nextActivityAt;
  assert.equal(validate(withoutDate), false,
    'a missing persisted activity timestamp cannot justify hasNext=true');
  assert.equal(validate({ ...withoutDate, hasNext: false, nextOverdue: true }), false,
    'a missing timestamp cannot justify an overdue action');
  assert.equal(validate({ ...row, nextActivityAt: undefined }), false,
    'an explicitly undefined timestamp cannot justify an upcoming action');

  assert.equal(validate({
    ...withoutDate, hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие',
  }), true, 'legacy rows with no next-action evidence remain loadable');
});
