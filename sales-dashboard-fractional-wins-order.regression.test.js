'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Dashboard wins retain the 20 newest CRM versions when deals share a millisecond', () => {
  // Exercise the actual read-only Dashboard on trusted in-memory snapshots.
  // There are no Bitrix, Sheets, Render, or network calls.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const context = {
    module: { exports: {} }, process: { env: {} },
    URL, AbortSignal, console,
  };
  vm.runInNewContext(source + `
    refreshTimedScores = () => {};
    module.exports.__insert = row => SALES.deals.set(row.dealId, row);
    module.exports.__status = status;
  `, context, { filename: 'sales.js' });
  const { __insert: insert, __status: readStatus } = context.module.exports;

  const normalizedUpdate = new Date(Date.now() - 60000).toISOString();
  const sourceAt = index => normalizedUpdate.replace(
    /Z$/, String(index).padStart(3, '0') + 'Z'
  );
  assert.equal(Date.parse(sourceAt(1)), Date.parse(sourceAt(21)),
    'Date.parse cannot distinguish these genuine CRM source versions');

  const ids = Array.from({ length: 21 }, (_, index) => String(99720001 + index));
  ids.forEach((dealId, index) => insert({
    dealId, title: 'Won ' + dealId, manager: 'Sales',
    categoryId: '0', stageId: 'WON', semantic: 'S', open: false,
    amount: 0, currency: 'RUB', hasNext: false,
    qualificationIssue: false, prospectScore: 10, riskScore: 0,
    // Sales stores source precision separately from its millisecond ISO
    // update field. Sorting only updatedAt drops that real distinction.
    sourceUpdatedAt: sourceAt(index + 1),
    updatedAt: normalizedUpdate,
    scoreHistory: [], alerts: [],
  }));

  const wins = readStatus().wins;
  assert.equal(wins.length, 20);
  assert.deepEqual(
    Array.from(wins, row => row.dealId),
    ids.slice(1).reverse(),
    'newest winning deal must be visible; oldest must be evicted at the limit',
  );
});
