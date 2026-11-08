'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sales = require('./sales');

test('read-only Dashboard discloses limited CRM scan and unsupported deletions', () => {
  const status = sales.status();
  assert.deepEqual(status.coverage, {
    recentDealLookbackDays: 45,
    deletedDealsReconciled: false,
    deletedActivitiesReconciled: false,
  });
  // A green recent-sync timestamp never proves a complete CRM census.
  // Until authenticated delete reconciliation exists, operators must not
  // interpret counts, scores or next actions as a complete live inventory.
  const html = sales.html();
  assert.match(html, /Ограничение охвата/);
  assert.match(html, /изменённые за последние 45 дней/);
  assert.match(html, /Удаления сделок и активностей Bitrix24 не сверяются/);
  assert.match(html, /Prospect\/Risk Score и Next Step могут включать устаревшие записи/);
});
