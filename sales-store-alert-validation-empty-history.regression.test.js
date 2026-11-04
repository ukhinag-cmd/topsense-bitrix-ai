'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored alerts are validated even when legacy deal has no score history', () => {
  // Google Sheets is an untrusted persistence boundary. This test executes
  // only the local validator: no Bitrix, Sheets, or Render network calls.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;
  const earlier = new Date(Date.now() - 120000).toISOString();
  const latest = new Date(Date.now() - 60000).toISOString();
  const row = {
    kind: 'salesDeal', dealId: '9965521', title: 'Legacy audit',
    manager: 'Manager', categoryId: '0', stageId: 'NEW',
    stageName: 'New', semantic: 'P', sourceStageSemantic: 'P',
    stageSemanticKnown: true, open: true,
    amount: 250000, currency: 'RUB', updatedAt: latest,
    sourceUpdatedAt: latest, nextStep: 'Schedule activity',
    hasNext: false, qualificationIssue: false,
    prospectScore: 70, riskScore: 25,
    scoreHistory: [], alerts: [],
  };
  const alert = {at: earlier, type: 'risk', title: 'Attention', detail: 'Unscheduled action'};
  assert.equal(validate(row), true, 'empty legacy score history remains supported');
  assert.equal(validate({...row, alerts: [alert]}), true, 'well-formed legacy alert can be restored');
  assert.equal(validate({...row, alerts: [{...alert, amount: 250000, currency: 'RUB'}]}), true,
    'well-formed historical monetary attribution can be restored');

  for (const badAlerts of [
    [{...alert, type: {toString: null}}],
    [{...alert, title: ['spoofed']}],
    [{...alert, at: 'not-a-date'}],
    [{...alert, amount: {value: 1}, currency: 'RUB'}],
    [{...alert, amount: 100000}], // partial monetary provenance
    [{...alert, currency: 'USD'}], // partial monetary provenance
    [{...alert, at: latest}, {...alert, at: earlier}], // reversed chronology
  ]) {
    assert.equal(validate({...row, alerts: badAlerts}), false,
      'untrusted or inconsistent alert data must be rejected without score history');
  }
});
