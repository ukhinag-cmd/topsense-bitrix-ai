'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A stored Sales row may be *observed* after the underlying CRM version.
// That newer observation is not permission to invent a later DATE_MODIFY or
// stage transition at the unchanged sourceUpdatedAt. They change Risk Score.
test('stored CRM modification and stage entry cannot outrun the source version', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const now = Date.now();
  const created = new Date(now - 6 * 86400000).toISOString();
  const crmVersion = new Date(now - 3 * 86400000).toISOString();
  const between = new Date(now - 86400000).toISOString();
  const observed = new Date(now - 60000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9975018', title: 'Source chronology',
    managerId: '', manager: '—', categoryId: '0',
    stageId: 'NEW', semantic: 'P', sourceStageSemantic: 'P', open: true,
    amount: 0, currency: 'RUB', createdAt: created,
    modifiedAt: crmVersion, stageEnteredAt: crmVersion,
    updatedAt: observed, sourceUpdatedAt: crmVersion,
    nextActivityAt: null, hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие', qualificationIssue: false,
    prospectScore: 30, riskScore: 45, scoreHistory: [], alerts: [],
  };
  assert.equal(validate(base), true,
    'a delayed observation of a valid CRM version remains loadable');
  assert.equal(validate({ ...base, modifiedAt: between }), false,
    'a claimed DATE_MODIFY after sourceUpdatedAt is unverified even if before updatedAt');
  assert.equal(validate({ ...base, stageEnteredAt: between }), false,
    'a claimed later stage transition would understate stage-age Risk Score');
  assert.equal(validate({ ...base, lastActivityAt: between }), true,
    'activity metadata can advance independently of the deal source version');
  assert.equal(validate({
    ...base, sourceUpdatedAt: null, modifiedAt: between, stageEnteredAt: between,
  }), true, 'legacy null source still uses the updatedAt observation bound');
});
