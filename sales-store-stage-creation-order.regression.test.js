'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted stage age cannot predate deal creation and invent Risk Score', () => {
  // Inspect the untrusted Sheet row contract without contacting a real CRM,
  // store, or deployed service.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const valid = context.module.exports.__validPersistedSnapshot;
  const now = Date.now();
  const created = new Date(now - 5 * 86400000).toISOString();
  const modified = new Date(now - 60000).toISOString();
  const row = {
    kind: 'salesDeal', dealId: '9915088',
    title: 'Chronology guard', manager: '—', categoryId: '0',
    stageId: 'NEW', semantic: 'P', sourceStageSemantic: 'P',
    stageSemanticKnown: true, open: true,
    amount: 250000, currency: 'RUB',
    createdAt: created, modifiedAt: modified, updatedAt: modified,
    sourceUpdatedAt: modified, stageEnteredAt: created,
    hasNext: false, nextStep: 'Назначить следующее действие',
    qualificationIssue: false, prospectScore: 30, riskScore: 45,
    scoreHistory: [], alerts: [],
  };
  assert.equal(valid(row), true, 'a stage entered on creation remains valid');
  assert.equal(valid({ ...row, stageEnteredAt: modified }), true,
    'a stage entered after creation remains valid');
  assert.equal(valid({ ...row, createdAt: null }), true,
    'older snapshots with an unknown creation date remain supported');
  assert.equal(valid({
    ...row, stageEnteredAt: new Date(now - 100 * 86400000).toISOString(),
  }), false, 'a stage cannot have been entered before its deal existed');
});
