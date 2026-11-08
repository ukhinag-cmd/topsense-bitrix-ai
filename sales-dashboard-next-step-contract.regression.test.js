'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Contract-only test: no CRM, Render, Sheets, email or network access.
test('Dashboard and JSON identify unverified Next Step evidence from deal fields', () => {
  const sales = require('./sales');
  const status = sales.status();
  // CRM deal fields do not document ACTIVITY_TIME / NEXT_ACTIVITY_TIME;
  // the actual list of incomplete activities requires crm.activity.list.
  // Missing a deal field must not be advertised as a proven empty schedule.
  assert.equal(status.scoringLimitations.nextStepNotVerifiedByActivityList, true);
  const html = sales.html();
  assert.match(html, /Next Step[^<]*не подтвержд[её]н[^<]*crm\.activity\.list/i);
  assert.match(html, /ACTIVITY_TIME/);
  assert.match(html, /NEXT_ACTIVITY_TIME/);
});
