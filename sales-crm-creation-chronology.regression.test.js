'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('CRM source and persisted deal creation cannot occur after the last source modification', () => {
  // Local validator-only regression: no live Bitrix, Sheet or Render requests.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__timelineGuards = { validateDealRow, validPersistedSnapshot };',
    context, { filename: 'sales.js' }
  );
  const { validateDealRow, validPersistedSnapshot } = context.module.exports.__timelineGuards;

  const now = Date.now();
  const created = new Date(now - 5 * 86400000).toISOString();
  const modified = new Date(now - 86400000).toISOString();
  const tooEarly = new Date(now - 6 * 86400000).toISOString();

  const live = {
    ID: '9915099', TITLE: 'Timeline consistency',
    ASSIGNED_BY_ID: '', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: created, DATE_MODIFY: modified,
  };
  assert.equal(validateDealRow(live), live, 'a normal update after creation is valid');
  assert.equal(validateDealRow({ ...live, DATE_MODIFY: created }).ID, live.ID,
    'creation and modification may have the same timestamp');
  assert.equal(validateDealRow({ ...live, DATE_CREATE: '' }).ID, live.ID,
    'a legacy CRM response without a creation date remains supported');
  assert.throws(() => validateDealRow({ ...live, DATE_MODIFY: tooEarly }),
    /DATE_CREATE|chronolog|timeline/i,
    'a pre-creation CRM version must fail closed rather than corrupt stage age');

  const stored = {
    kind: 'salesDeal', dealId: live.ID, title: live.TITLE, manager: '—',
    categoryId: '0', stageId: 'NEW', semantic: 'P',
    sourceStageSemantic: 'P', stageSemanticKnown: true, open: true,
    amount: 250000, currency: 'RUB',
    createdAt: created, modifiedAt: modified,
    updatedAt: modified, sourceUpdatedAt: modified,
    stageEnteredAt: created, hasNext: false, qualificationIssue: false,
    prospectScore: 40, riskScore: 30,
    nextStep: 'Назначить следующее действие', scoreHistory: [], alerts: [],
  };
  assert.equal(validPersistedSnapshot(stored), true);
  assert.equal(validPersistedSnapshot({ ...stored, createdAt: null }), true,
    'older stored rows without creation dates stay compatible');
  assert.equal(validPersistedSnapshot({ ...stored, createdAt: modified, stageEnteredAt: modified }), true,
    'equal creation and last CRM update time is valid');
  assert.equal(validPersistedSnapshot({
    ...stored,
    updatedAt: tooEarly,
    sourceUpdatedAt: tooEarly,
  }), false, 'a saved CRM update cannot predate the deal creation');
});
