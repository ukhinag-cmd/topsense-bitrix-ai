'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Only a timezone-qualified CRM version can be compared reliably with live
// Bitrix DATE_MODIFY. Local-time/date-only Sheet values are ambiguous across
// machines and must not become authoritative after a restart.
test('stored source and displayed versions require explicit time zone', () => {
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validate = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validate;
  const now = Date.now();
  const at = new Date(now - 60_000).toISOString();
  const createdAt = new Date(now - 86_400_000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9971563', title: 'Trusted deal',
    manager: '—', managerId: '', categoryId: '0', stageId: 'NEW',
    semantic: 'P', sourceStageSemantic: 'P', stageSemanticKnown: true,
    open: true, amount: 250000, currency: 'RUB', createdAt,
    updatedAt: at, sourceUpdatedAt: at,
    nextActivityAt: null, hasNext: false, qualificationIssue: false,
    prospectScore: 45, riskScore: 30, nextStep: 'Назначить действие',
    scoreHistory: [], alerts: [],
  };
  assert.equal(validate(base), true, 'canonical saved UTC version is valid');
  assert.equal(validate({ ...base, sourceUpdatedAt: null }), true,
    'older snapshots without an authoritative source version are valid');

  const localTime = at.slice(0, -1); // ISO datetime without its Z/offset
  assert.equal(validate({ ...base, sourceUpdatedAt: localTime }), false,
    'sourceUpdatedAt must not use host-local timezone');
  assert.equal(validate({ ...base, updatedAt: localTime, sourceUpdatedAt: null }), false,
    'fallback version updatedAt must not use host-local timezone');
  assert.equal(validate({ ...base, updatedAt: at.slice(0, 10), sourceUpdatedAt: null }), false,
    'a date-only value cannot identify a CRM update version');

  const utcOffset = new Date(now - 120_000).toISOString()
    .replace('Z', '+00:00');
  assert.equal(validate({ ...base, sourceUpdatedAt: utcOffset }), true,
    'a source version with an explicit UTC offset remains valid');
});
