'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Sales emits ISO timestamps with an explicit zone for both score observations
// and alerts. Sheet rows without a zone are interpreted differently depending
// on the runtime host's timezone, corrupting the read-only audit timeline.
test('stored score and alert audit timestamps require an explicit timezone', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;

  const older = new Date(Date.now() - 180000).toISOString();
  const newer = new Date(Date.now() - 120000).toISOString();
  const row = {
    kind: 'salesDeal', dealId: '998517',
    title: 'Timezone audit', manager: 'Sales',
    stageId: 'NEW', semantic: 'P', open: true, amount: 0,
    currency: 'RUB', updatedAt: newer, sourceUpdatedAt: older,
    nextStep: 'Назначить действие', hasNext: false,
    qualificationIssue: false, prospectScore: 30, riskScore: 45,
    scoreHistory: [{
      at: newer, amount: 0, currency: 'RUB',
      prospectScore: 30, riskScore: 45, stageId: 'NEW',
    }],
    alerts: [{ at: newer, type: 'warning', title: 'Check', detail: 'Follow up' }],
  };
  assert.equal(validate(row), true, 'normal UTC audit observations remain loadable');
  const zoneless = newer.slice(0, -1);
  assert.equal(validate({
    ...row, scoreHistory: [{ ...row.scoreHistory[0], at: zoneless }]
  }), false, 'zone-free stored score audit must not be treated as authoritative');
  assert.equal(validate({
    ...row, alerts: [{ ...row.alerts[0], at: zoneless }]
  }), false, 'zone-free stored alert audit must not be treated as authoritative');
  assert.equal(validate({
    ...row, scoreHistory: [{ ...row.scoreHistory[0], at: newer.slice(0, 10) }]
  }), false, 'date-only score audit cannot identify an observation instant');
  assert.equal(validate({
    ...row, alerts: [{ ...row.alerts[0], at: newer.slice(0, 10) }]
  }), false, 'date-only alert audit cannot identify an observation instant');

  const withOffset = newer.replace('Z', '+00:00');
  assert.equal(validate({
    ...row,
    scoreHistory: [{ ...row.scoreHistory[0], at: withOffset }],
    alerts: [{ ...row.alerts[0], at: withOffset }],
  }), true, 'equivalent explicit UTC-offset timestamps remain valid');
});
