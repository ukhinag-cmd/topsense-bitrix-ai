'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored Sales semantic provenance must be canonical before hydration', () => {
  // Exercise the same validator used by the Sheet hydration path without
  // contacting Bitrix, the Sheet store, or Render.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;

  const recent = new Date(Date.now() - 60000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9921771', title: 'Verified stored deal',
    manager: 'Manager', stageId: 'NEW', semantic: 'P',
    sourceStageSemantic: 'P', stageSemanticKnown: true,
    open: true, amount: 200000, currency: 'RUB',
    updatedAt: recent, sourceUpdatedAt: recent,
    nextStep: 'Назначить действие', hasNext: false,
    qualificationIssue: false, prospectScore: 45, riskScore: 30,
    scoreHistory: [], alerts: [],
  };

  assert.equal(validate(base), true, 'verified canonical semantic is loadable');
  assert.equal(validate({ ...base, semantic: 'X' }), false,
    'a non-Bitrix semantic must not be hydrated as an open deal');
  assert.equal(validate({ ...base, semantic: 's' }), false,
    'uncanonical case must not fabricate a different closed outcome');
  assert.equal(validate({ ...base, sourceStageSemantic: 'X' }), false,
    'unknown direct semantic must not override stage metadata on refresh');
  assert.equal(validate({ ...base, stageSemanticKnown: false }), false,
    'the stored known flag must agree with a recognized semantic');

  // A stage whose semantics are not yet known is legitimate and needs
  // follow-up verification, not a fabricated success or failure.
  assert.equal(validate({
    ...base, semantic: '', sourceStageSemantic: '',
    stageSemanticKnown: false, open: true,
  }), true, 'unknown but empty semantic remains compatible');
  const legacy = { ...base };
  delete legacy.sourceStageSemantic;
  delete legacy.stageSemanticKnown;
  assert.equal(validate(legacy), true, 'older snapshots may omit provenance fields');
});
