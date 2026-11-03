'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored pipeline categories must use canonical Bitrix IDs before stage rescoring', () => {
  // Local hydration contract only: never contact CRM, Sheets, or Render.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const valid = context.module.exports.__validPersistedSnapshot;
  const now = new Date(Date.now() - 60000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9931001', title: 'Pipeline identity regression',
    manager: 'Manager', categoryId: '7', stageId: 'NEW',
    semantic: 'P', sourceStageSemantic: '', stageSemanticKnown: true, open: true,
    amount: 250000, currency: 'RUB',
    updatedAt: now, sourceUpdatedAt: now, createdAt: now,
    stageEnteredAt: now, hasNext: false,
    nextStep: 'Назначить следующее действие', qualificationIssue: false,
    prospectScore: 40, riskScore: 30, scoreHistory: [], alerts: [],
  };

  assert.equal(valid(base), true, 'a canonical non-default pipeline stays loadable');
  assert.equal(valid({ ...base, categoryId: '0' }), true,
    'the default pipeline remains valid');
  assert.equal(valid({ ...base, categoryId: null }), true,
    'older snapshots without a pipeline ID remain compatible');
  for (const categoryId of ['07', ' 7 ', '', 'bad', '-1', '9007199254740992']) {
    assert.equal(valid({ ...base, categoryId }), false,
      'noncanonical pipeline ' + JSON.stringify(categoryId) +
      ' must not bypass stage lookup and fabricate an unknown-stage Risk Score');
  }
});
