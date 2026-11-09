'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted CRM chronology rejects source and stage timestamps beyond sub-millisecond source versions', () => {
  // Read the untrusted Sheet hydration validator without calling Bitrix,
  // Google Sheets, Render, or any outbound endpoint.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;

  const created = new Date(Date.now() - 7 * 86400000).toISOString();
  const normalizedVersion = new Date(Date.now() - 3600000).toISOString();
  const sourceVersion = normalizedVersion.replace(/Z$/, '1Z');
  const afterSourceWithinSameMs = normalizedVersion.replace(/Z$/, '2Z');
  const row = {
    kind: 'salesDeal', dealId: '9995318', title: 'Fractional chronology',
    managerId: '', manager: '—', categoryId: '0',
    stageId: 'NEW', semantic: 'P', sourceStageSemantic: 'P',
    stageSemanticKnown: true, open: true,
    amount: 0, currency: 'RUB',
    createdAt: created, updatedAt: normalizedVersion,
    sourceUpdatedAt: sourceVersion, modifiedAt: normalizedVersion,
    stageEnteredAt: normalizedVersion,
    nextActivityAt: null, hasNext: false, nextOverdue: false,
    nextStep: 'Назначить следующее действие',
    qualificationIssue: false, prospectScore: 30, riskScore: 10,
    scoreHistory: [], alerts: [],
  };
  assert.equal(validate(row), true,
    'Sales rounds displayed dates to milliseconds even when CRM source has extra precision');
  assert.equal(validate({ ...row, modifiedAt: afterSourceWithinSameMs }), false,
    'a stored DATE_MODIFY must not outrun the raw source version inside one millisecond');
  assert.equal(validate({ ...row, stageEnteredAt: afterSourceWithinSameMs }), false,
    'a stored stage transition must not postdate its raw source version');
  assert.equal(validate({ ...row, sourceUpdatedAt: null }), true,
    'legacy snapshots without a source version keep the updatedAt fallback');
});
