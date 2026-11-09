'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Offline integrity check: production scoring only emits integer points.
// Malformed Sheet history must not introduce synthetic fractional scores.
test('stored Prospect/Risk Scores and score history must contain whole points', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const at = new Date(Date.now() - 60_000).toISOString();
  const history = {
    at, categoryId: '0', stageId: 'NEW', semantic: 'P',
    amount: 300000, currency: 'RUB', prospectScore: 75, riskScore: 30,
  };
  const base = {
    kind: 'salesDeal', dealId: '9968821', title: 'Stored score integrity',
    manager: 'Manager', categoryId: '0', stageId: 'NEW', semantic: 'P',
    sourceStageSemantic: 'P', stageSemanticKnown: true, open: true,
    amount: 300000, currency: 'RUB', updatedAt: at, sourceUpdatedAt: at,
    nextStep: 'Назначить действие', hasNext: false,
    qualificationIssue: false, prospectScore: 75, riskScore: 30,
    scoreHistory: [history], alerts: [],
  };
  assert.equal(validate(base), true, 'real whole-point scores remain loadable');
  for (const field of ['prospectScore', 'riskScore']) {
    const fractional = field === 'prospectScore' ? 74.5 : 29.5;
    // Even a self-consistent forged snapshot and audit tail are not an
    // authentic outcome of the scoring algorithm.
    const corrupted = {
      ...base,
      [field]: fractional,
      scoreHistory: [{ ...history, [field]: fractional }],
    };
    assert.equal(validate(corrupted), false,
      'fractional persisted ' + field + ' must not be trusted');
    assert.equal(validate({
      ...base, scoreHistory: [{ ...history, [field]: fractional }, history],
    }), false, 'fractional old history ' + field + ' must be rejected');
  }
});
