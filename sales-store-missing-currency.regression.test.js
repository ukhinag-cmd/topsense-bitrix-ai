'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('nonzero stored deal amounts require an explicit currency before hydration', () => {
  // An untrusted Sheet snapshot must not cause temporal rescoring to infer
  // RUB when the originally persisted currency is missing. No live I/O.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;
  const recent = new Date(Date.now() - 60000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9921991', title: 'Persisted deal',
    manager: 'Manager', stageId: 'NEW', semantic: 'P', open: true,
    amount: 200000, currency: 'RUB', updatedAt: recent,
    sourceUpdatedAt: recent, nextStep: 'Назначить действие',
    hasNext: false, qualificationIssue: false, prospectScore: 45,
    riskScore: 30, scoreHistory: [], alerts: [],
  };

  assert.equal(validate(base), true, 'canonical RUB snapshot stays loadable');
  assert.equal(validate({ ...base, currency: 'USD' }), true, 'foreign currency stays loadable');
  assert.equal(validate({ ...base, currency: '' }), false,
    'missing currency on a nonzero amount must not later be inferred as RUB');
  assert.equal(validate({ ...base, currency: '  ' }), false,
    'whitespace currency on a nonzero amount must not be trusted');
  assert.equal(validate({ ...base, amount: 0, currency: '' }), true,
    'legacy zero-value deals may have no currency');
});
