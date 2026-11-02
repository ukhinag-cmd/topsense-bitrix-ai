'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('stored currency padding must not silently exclude RUB from dashboard totals', () => {
  // Use the actual hydration validator and read-only Dashboard implementation.
  // Everything is evaluated locally: no Bitrix, Sheets, Render or network I/O.
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  const sandbox = {
    module: { exports: {} }, process: { env: {} }, URL, AbortSignal, console,
    setTimeout: () => ({ unref() {} }),
  };
  vm.runInNewContext(
    source + '\nmodule.exports = { SALES, status, validPersistedSnapshot };',
    sandbox, { filename: 'sales.js' }
  );
  const { SALES, status, validPersistedSnapshot } = sandbox.module.exports;
  const now = Date.now();
  const base = {
    kind: 'salesDeal', dealId: '9987330', title: 'Stored currency normalization',
    manager: 'Manager', managerId: '7', categoryId: '0', stageId: 'NEW',
    sourceStageSemantic: 'P', semantic: 'P', stageSemanticKnown: true,
    open: true, amount: 250000, currency: ' RUB ',
    createdAt: new Date(now - 86400000).toISOString(),
    stageEnteredAt: new Date(now - 3600000).toISOString(),
    lastActivityAt: new Date(now - 60000).toISOString(),
    nextActivityAt: new Date(now + 3600000).toISOString(),
    updatedAt: new Date(now - 30000).toISOString(),
    sourceUpdatedAt: new Date(now - 30000).toISOString(),
    nextStep: 'Следующее действие', hasNext: true, qualificationIssue: false,
    prospectScore: 40, riskScore: 0, scoreHistory: [], alerts: [],
  };
  assert.equal(validPersistedSnapshot(base), true,
    'legacy padded currency is accepted by hydration and must be counted consistently');
  SALES.deals.set(base.dealId, base);

  const foreign = { ...base, dealId: '9987331', currency: ' USD ' };
  assert.equal(validPersistedSnapshot(foreign), true);
  SALES.deals.set(foreign.dealId, foreign);

  const dashboard = status();
  assert.equal(dashboard.counts.open, 2);
  assert.equal(dashboard.sums.open, 250000,
    'RUB subtotal must agree with scoreDeal currency normalization');
  assert.equal(dashboard.excludedCurrencyCounts.open, 1,
    'only USD, not padded RUB, must be classified as a foreign currency');
});
