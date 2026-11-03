'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('persisted Sales manager identity rejects noncanonical IDs before hydration', () => {
  // Only local validator execution. No actual Bitrix, Sheet, or Render I/O.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console };
  vm.runInNewContext(
    source + '\nmodule.exports.__validPersistedSnapshot = validPersistedSnapshot;',
    context, { filename: 'sales.js' }
  );
  const validate = context.module.exports.__validPersistedSnapshot;
  const updatedAt = new Date(Date.now() - 60_000).toISOString();
  const base = {
    kind: 'salesDeal', dealId: '9934001', title: 'Verified manager identity',
    manager: 'Verified manager', managerId: '7', stageId: 'NEW',
    semantic: 'P', open: true, amount: 100000, currency: 'RUB',
    updatedAt, sourceUpdatedAt: updatedAt, createdAt: updatedAt,
    stageEnteredAt: updatedAt, hasNext: false,
    nextStep: 'Назначить следующее действие', qualificationIssue: false,
    prospectScore: 40, riskScore: 30, scoreHistory: [], alerts: [],
  };

  for (const id of ['7', '0', '', undefined]) {
    assert.equal(validate({ ...base, managerId: id }), true,
      'canonical or legacy unassigned manager ' + String(id) + ' must remain loadable');
  }
  for (const id of ['07', ' 7 ', '7.0', '7e0', '-1', 'N/A', '9007199254740992']) {
    assert.equal(validate({ ...base, managerId: id }), false,
      'untrusted stored manager ID ' + JSON.stringify(id) +
      ' must not be attributed to a canonical Bitrix user after restart');
  }
});
