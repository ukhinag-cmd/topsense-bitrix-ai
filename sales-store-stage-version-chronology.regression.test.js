'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Sales reads deal DATE_MODIFY as its source version. A stage entry or
// modified instant later than that version cannot describe an observed
// CRM transition. Restoring such Sheet data would understate stage-age Risk.
test('stored stage and modified chronology cannot postdate the CRM version', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const now = Date.now();
  const created = new Date(now - 4 * 86400000).toISOString();
  const version = new Date(now - 2 * 86400000).toISOString();
  const stage = new Date(now - 3 * 86400000).toISOString();
  const afterVersion = new Date(now - 86400000).toISOString();
  const row = {
    kind: 'salesDeal', dealId: '998521', title: 'Chronology test',
    manager: 'Sales', stageId: 'NEW', semantic: 'P', open: true,
    amount: 0, currency: 'RUB', createdAt: created,
    modifiedAt: version, stageEnteredAt: stage,
    updatedAt: version, sourceUpdatedAt: version,
    nextActivityAt: null, hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие', qualificationIssue: false,
    prospectScore: 30, riskScore: 10, scoreHistory: [], alerts: [],
  };
  assert.equal(validate(row), true, 'valid historical stage timeline should hydrate');
  assert.equal(validate({ ...row, stageEnteredAt: version }), true,
    'stage may enter exactly at the CRM update');
  assert.equal(validate({ ...row, stageEnteredAt: afterVersion }), false,
    'unobserved stage move must not reset stage-age Risk');
  assert.equal(validate({ ...row, modifiedAt: afterVersion }), false,
    'DATE_MODIFY provenance cannot be later than the stored source version');
  assert.equal(validate({ ...row, sourceUpdatedAt: null }), true,
    'legacy null CRM source version keeps using updatedAt');
});
