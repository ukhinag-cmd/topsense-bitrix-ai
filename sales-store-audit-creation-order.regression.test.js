'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted Sales audit observations cannot predate CRM deal creation', () => {
  // Startup hydration validation only. No CRM, Sheet, or Render requests.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const valid = context.module.exports.__validPersistedSnapshot;
  const creation = new Date(Date.now() - 2 * 86400000).toISOString();
  const recent = new Date(Date.now() - 60000).toISOString();
  const beforeCreation = new Date(Date.now() - 3 * 86400000).toISOString();
  const history = at => ({
    at, categoryId: '0', stageId: 'NEW', semantic: 'P',
    amount: 250000, currency: 'RUB', prospectScore: 60, riskScore: 25,
  });
  const alert = at => ({
    at, type: 'warning', title: 'Проверить действие', detail: 'Действие не назначено',
  });
  const base = {
    kind: 'salesDeal', dealId: '9955441', title: 'Audit creation chronology',
    manager: 'Manager', categoryId: '0', stageId: 'NEW',
    semantic: 'P', open: true, amount: 250000, currency: 'RUB',
    createdAt: creation, stageEnteredAt: creation,
    updatedAt: recent, sourceUpdatedAt: recent,
    nextStep: 'Назначить следующее действие', hasNext: false,
    qualificationIssue: false, prospectScore: 60, riskScore: 25,
    scoreHistory: [history(recent)], alerts: [alert(recent)],
  };

  assert.equal(valid(base), true, 'real post-creation observations load');
  assert.equal(valid({ ...base, scoreHistory: [history(creation)] }), true,
    'an observation exactly at creation is legitimate');
  assert.equal(valid({ ...base, scoreHistory: [history(beforeCreation)] }), false,
    'a pre-creation score history must not be trusted');
  assert.equal(valid({ ...base, alerts: [alert(beforeCreation)] }), false,
    'a pre-creation alert must not be trusted');
  assert.equal(valid({ ...base, createdAt: null, scoreHistory: [history(beforeCreation)] }), true,
    'legacy rows without a known creation timestamp remain supported');
});
