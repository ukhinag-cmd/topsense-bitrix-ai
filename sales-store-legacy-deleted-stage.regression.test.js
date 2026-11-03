'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('legacy inferred outcome is corrected when a verified pipeline no longer contains its stage', () => {
  // Execute the actual scoring and hydration logic with no CRM, Sheet, Render,
  // network, interval or scheduled persistence work.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = {
    module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console,
    setTimeout: () => ({ unref() {} }),
  };
  vm.runInNewContext(
    source + '\nmodule.exports = { SALES, status, validPersistedSnapshot };',
    context, { filename: 'sales.js' }
  );
  const { SALES, status, validPersistedSnapshot } = context.module.exports;

  const observedAt = new Date(Date.now() - 86400000).toISOString();
  const id = '9939771';
  const old = {
    kind: 'salesDeal', dealId: id, title: 'Legacy closed stage',
    manager: '—', managerId: '', categoryId: '7',
    stageId: 'C7:REMOVED', stageName: 'Removed stage',
    // Legacy snapshots did not have sourceStageSemantic. This S was inferred
    // by a previous verified stage dictionary, not sent directly by Bitrix.
    semantic: 'S', stageSemanticKnown: true, open: false,
    amount: 0, currency: 'RUB', updatedAt: observedAt,
    sourceUpdatedAt: observedAt, modifiedAt: observedAt,
    createdAt: observedAt, stageEnteredAt: observedAt,
    nextActivityAt: null, lastActivityAt: null,
    nextStep: 'Сделка завершена успешно', hasNext: false,
    qualificationIssue: false, qualificationStatus: '', clientType: '',
    prospectScore: 5, riskScore: 0, scoreHistory: [], alerts: [],
  };
  assert.equal(validPersistedSnapshot(old), true,
    'a backward-compatible snapshot without provenance must remain loadable');
  SALES.deals.set(id, old);

  // When the stage dictionary is unavailable, retain the trusted historical
  // inference rather than inventing a stage transition during the outage.
  let state = status();
  assert.equal(state.counts.won, 1);
  assert.equal(state.counts.open, 0);

  // A successful nonempty read verifies this category, but the old stage has
  // disappeared. The legacy fallback must no longer override that evidence.
  SALES.stages.set('7:C7:NEW', { name: 'Новая', semantics: 'P' });
  SALES.stageCategoriesLoaded.add('7');
  state = status();
  assert.equal(state.counts.won, 0,
    'removed stage must not remain a fabricated closed-won deal');
  assert.equal(state.counts.open, 1);
  assert.equal(state.attention[0]?.semantic, '');
  assert.match(state.attention[0]?.nextStep || '', /Проверить стадию/);
  assert.equal(state.attention[0]?.sourceUpdatedAt, observedAt,
    'stage metadata corrections must not invent a CRM version');
  assert.equal(state.alerts.some(alert => alert.type === 'warning'), false,
    'stage metadata corrections must not generate a new CRM warning');

  // An explicitly CRM-provided semantic must still override missing stages.
  SALES.deals.set(id, { ...old, sourceStageSemantic: 'S' });
  state = status();
  assert.equal(state.counts.won, 1);
});
