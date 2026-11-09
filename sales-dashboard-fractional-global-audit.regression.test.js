'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Dashboard picks the latest 25 cross-deal scores and newest alerts at fractional CRM precision', () => {
  // Inject trusted in-memory snapshots into the real read-only status
  // aggregator. No Bitrix/Sheets/Render calls and no network access.
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

  const base = new Date(Date.now() - 60000).toISOString();
  const observed = index => base.replace(/Z$/, String(index).padStart(6, '0') + 'Z');
  const earlier = observed(1);
  const later = observed(26);
  assert.equal(Date.parse(earlier), Date.parse(later),
    'these distinct audit instants collide at JavaScript millisecond precision');

  const ids = Array.from({ length: 26 }, (_, index) => String(9998101 + index));
  ids.forEach((dealId, index) => {
    const at = observed(index + 1);
    insert({
      dealId, title: 'Audit deal ' + dealId,
      manager: 'Sales', categoryId: '0', stageId: 'NEW',
      semantic: 'P', open: true, amount: 0, currency: 'RUB',
      updatedAt: base, prospectScore: 30, riskScore: 25,
      qualificationIssue: false, hasNext: true,
      scoreHistory: [{
        at, stageId: 'NEW', semantic: 'P', amount: 0,
        currency: 'RUB', prospectScore: 30, riskScore: 25,
      }],
      alerts: (index === 0 || index === 25) ? [{
        at, type: 'warning', title: 'Check', detail: 'Verify action',
      }] : [],
    });
  });

  const result = readStatus();
  assert.equal(result.recentHistory.length, 25);
  assert.deepEqual(
    Array.from(result.recentHistory, entry => entry.dealId),
    ids.slice(1).reverse(),
    'newest fractional observation must be retained; oldest must be evicted',
  );
  assert.deepEqual(
    Array.from(result.alerts, alert => alert.dealId),
    [ids[25], ids[0]],
    'read-only alert feed must also order sub-millisecond instants',
  );
});
