'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Sales emits normalized ISO instants for all stored temporal provenance,
// not just CRM versions and alert/history timestamps. Ambiguous date-only
// or timezone-free Sheet values can change Risk/Next Step after a restart.
test('stored optional deal/activity timestamps require explicit zones', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const now = Date.now();
  const observed = new Date(now - 60000).toISOString();
  const created = new Date(now - 48 * 3600000).toISOString();
  const planned = new Date(now + 2 * 3600000).toISOString();
  const row = {
    kind: 'salesDeal', dealId: '998518', title: 'Timezone provenance',
    manager: 'Sales', stageId: 'NEW', semantic: 'P', open: true,
    amount: 0, currency: 'RUB', updatedAt: observed, sourceUpdatedAt: observed,
    nextStep: 'Scheduled activity', hasNext: true, nextOverdue: false,
    qualificationIssue: false, prospectScore: 30, riskScore: 10,
    createdAt: created, modifiedAt: created, lastActivityAt: created,
    stageEnteredAt: created, observedAt: observed, nextActivityAt: planned,
    scoreHistory: [], alerts: [],
  };
  assert.equal(validate(row), true, 'normal UTC snapshot must load');
  for (const [field, original] of [
    ['createdAt', created], ['modifiedAt', created],
    ['lastActivityAt', created], ['stageEnteredAt', created],
    ['observedAt', observed], ['nextActivityAt', planned],
  ]) {
    assert.equal(validate({ ...row, [field]: original.slice(0, -1) }), false,
      field + ' must reject timezone-free datetime');
    assert.equal(validate({ ...row, [field]: original.slice(0, 10) }), false,
      field + ' must reject date-only value');
    assert.equal(validate({ ...row, [field]: original.replace('Z', '+00:00') }), true,
      field + ' must accept an explicit UTC offset');
    assert.equal(validate({ ...row, [field]: null }), true,
      field + ' remains optional for legacy records');
  }
});
