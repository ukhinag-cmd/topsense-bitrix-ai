'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored Sales snapshot must agree with its latest scored audit entry', () => {
  // The Sheet payload is untrusted. Exercise startup validation locally,
  // without reading or modifying Bitrix, Google Sheets or Render.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;
  const earlier = new Date(Date.now() - 120000).toISOString();
  const latest = new Date(Date.now() - 60000).toISOString();
  const final = {
    at: latest, categoryId: '0', stageId: 'NEW', stageName: 'Новая',
    semantic: 'P', amount: 250000, currency: 'RUB',
    prospectScore: 70, riskScore: 25,
  };
  const row = {
    kind: 'salesDeal', dealId: '9965511', title: 'Audit consistency',
    manager: 'Manager', categoryId: '0', stageId: 'NEW',
    stageName: 'Новая', semantic: 'P', sourceStageSemantic: 'P',
    stageSemanticKnown: true, open: true,
    amount: 250000, currency: 'RUB', updatedAt: latest,
    sourceUpdatedAt: latest, nextStep: 'Назначить действие', hasNext: false,
    qualificationIssue: false, prospectScore: 70, riskScore: 25,
    scoreHistory: [{ ...final, at: earlier, prospectScore: 65 }, final],
    alerts: [],
  };
  assert.equal(validate(row), true, 'consistent latest audit entry can be restored');
  assert.equal(validate({ ...row, scoreHistory: [] }), true,
    'historical snapshots with no scored audit entries remain supported');

  // A stale or tampered last entry must not be shown as an authoritative
  // progression alongside contradictory Dashboard scores and deal outcome.
  for (const [field, value] of [
    ['semantic', 'S'], ['stageId', 'C1:WON'], ['categoryId', '8'],
    ['amount', 900000], ['currency', 'USD'],
    ['prospectScore', 45], ['riskScore', 80],
  ]) {
    assert.equal(validate({ ...row, scoreHistory: [
      { ...final, at: earlier }, { ...final, [field]: value },
    ] }), false, 'mismatched latest audit ' + field + ' must be rejected');
  }

  // Older audit formats may have no semantic, category or currency fields.
  // Missing optional provenance is not itself evidence of corruption.
  const legacy = { ...final };
  delete legacy.semantic;
  delete legacy.categoryId;
  delete legacy.currency;
  assert.equal(validate({ ...row, scoreHistory: [legacy] }), true,
    'old but consistent scored history remains compatible');
});
