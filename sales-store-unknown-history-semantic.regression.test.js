'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted score history accepts unknown stage semantics emitted by Sales', () => {
  // Missing stage metadata is allowed to remain unknown ("") until a
  // verified Bitrix dictionary arrives. That same unknown semantic is
  // recorded in scoreHistory; startup must not discard the entire deal.
  // No real Bitrix, Google Sheet or Render I/O.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;
  const recent = new Date(Date.now() - 60000).toISOString();
  const entry = {
    at: recent, categoryId: '0', stageId: 'UNKNOWN',
    stageName: 'UNKNOWN', semantic: '', amount: 200000,
    currency: 'RUB', prospectScore: 35, riskScore: 65,
  };
  const row = {
    kind: 'salesDeal', dealId: '9931771', title: 'Unresolved Bitrix stage',
    manager: 'Manager', categoryId: '0', stageId: 'UNKNOWN',
    semantic: '', sourceStageSemantic: '', stageSemanticKnown: false,
    open: true, amount: 200000, currency: 'RUB',
    updatedAt: recent, sourceUpdatedAt: recent, nextStep: 'Проверить стадию',
    hasNext: false, qualificationIssue: false, prospectScore: 35,
    riskScore: 65, scoreHistory: [entry], alerts: [],
  };
  assert.equal(validate(row), true,
    'a snapshot written with an unresolved stage must survive restart');
  assert.equal(validate({ ...row, scoreHistory: [
    { ...entry, semantic: 'P' }, entry,
  ] }), true, 'a legitimate transition to unknown semantics must survive');
  assert.equal(validate({ ...row, scoreHistory: [
    { ...entry, semantic: 'X' },
  ] }), false, 'arbitrary history semantics must remain blocked');
  assert.equal(validate({ ...row, scoreHistory: [
    { ...entry, semantic: ['P'] },
  ] }), false, 'coercible arrays must remain blocked');
});
