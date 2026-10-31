'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored Sales snapshots reject malformed optional scalar fields before Dashboard refresh', () => {
  // Test the validator used by startup hydration. No Bitrix, Sheet, or Render I/O.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;

  const now = new Date(Date.now() - 60000).toISOString();
  const history = {
    at: now, stageId: 'NEW', stageName: 'New', amount: 250000,
    currency: 'RUB', prospectScore: 70, riskScore: 20,
  };
  const base = {
    kind: 'salesDeal', dealId: '9920451', title: 'Verified stored deal',
    manager: 'Manager', managerId: '7', sourceId: 'WEB', categoryId: '0',
    stageId: 'NEW', stageName: 'New', semantic: 'P', stageSemanticKnown: true,
    open: true, amount: 250000, currency: 'RUB', updatedAt: now,
    sourceUpdatedAt: now, observedAt: now, observedFrom: 'sync',
    nextStep: 'Назначить действие', hasNext: false, nextOverdue: false,
    qualificationIssue: false, qualificationStatus: 'Квалифицировано',
    clientType: 'dealer', prospectScore: 70, riskScore: 20,
    scoreHistory: [history], alerts: [],
  };

  assert.equal(validate(base), true, 'valid generated scalar fields remain loadable');
  const malformed = [
    ['managerId', ['7']],
    ['sourceId', ['WEB']],
    ['categoryId', ['0']],
    ['stageName', ['New']],
    ['qualificationStatus', ['Квалифицировано']],
    ['clientType', { toString: null }],
    ['observedFrom', { toString: null }],
    ['stageSemanticKnown', ['true']],
    ['nextOverdue', ['false']],
  ];
  for (const [field, value] of malformed) {
    assert.equal(validate({ ...base, [field]: value }), false,
      field + ' must not be accepted from untrusted persisted history');
  }

  for (const field of ['stageId', 'stageName', 'currency']) {
    assert.equal(validate({ ...base, scoreHistory: [{ ...history, [field]: ['spoofed'] }] }),
      false, 'history ' + field + ' must remain scalar');
  }
  // Older snapshots may omit these nonessential metadata fields entirely.
  const legacy = { ...base };
  for (const [field] of malformed) delete legacy[field];
  assert.equal(validate(legacy), true, 'missing optional legacy fields stay compatible');
});
