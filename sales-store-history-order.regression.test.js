'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored score history must be chronological before Sales hydrates it', () => {
  // Run the same persisted-row validator used at startup, without accessing
  // Bitrix, Google Sheets, Render or any network service.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;

  const older = new Date(Date.now() - 3 * 60000).toISOString();
  const newer = new Date(Date.now() - 2 * 60000).toISOString();
  const historyRow = at => ({
    at, stageId: 'NEW', stageName: 'New', amount: 250000,
    currency: 'RUB', prospectScore: 70, riskScore: 20,
  });
  const base = {
    kind: 'salesDeal', dealId: '9914445',
    title: 'History chronology', manager: 'Manager',
    stageId: 'NEW', semantic: 'P', open: true, amount: 250000,
    currency: 'RUB', updatedAt: newer, sourceUpdatedAt: older,
    nextStep: 'Назначить действие', hasNext: false,
    qualificationIssue: false, prospectScore: 70, riskScore: 20,
    scoreHistory: [historyRow(older), historyRow(newer)],
    alerts: [],
  };

  assert.equal(validate(base), true, 'normal chronological history remains loadable');
  assert.equal(validate({ ...base, scoreHistory: [historyRow(older), historyRow(older)] }), true,
    'multiple score observations at the same millisecond remain valid');
  assert.equal(
    validate({ ...base, scoreHistory: [historyRow(newer), historyRow(older)] }), false,
    'out-of-order persisted history must not be loaded as trustworthy Sales history'
  );
});
