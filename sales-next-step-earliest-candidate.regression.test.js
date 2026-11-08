'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Read-only mocked REST: two optional schedule timestamps must not let a
// later date mask the earliest actionable/overdue CRM deadline.
test('Next Step chooses earliest real candidate, including an overdue secondary date', async t => {
  const previousFetch = global.fetch;
  const before = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = previousFetch;
    for (const [key, val] of Object.entries(before)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const now = Date.now();
  const day = 86400000;
  const at = offset => new Date(now + offset * day).toISOString();
  const id = '9950091';
  const later = at(5);
  const earlier = at(1);
  let deal = {
    ID: id, TITLE: 'Two candidate deadlines', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '350000', CURRENCY_ID: 'RUB',
    DATE_CREATE: at(-3), DATE_MODIFY: at(-0.01),
    LAST_ACTIVITY_TIME: at(-0.01),
    ACTIVITY_TIME: later, NEXT_ACTIVITY_TIME: earlier,
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let calls = 0;
  global.fetch = async input => {
    assert.match(new URL(String(input)).pathname, /\/crm\.deal\.get\.json$/);
    calls++;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };
  const sales = require('./sales');
  const current = () => {
    const s = sales.status();
    return s.prospects.find(x => x.dealId === id) ||
      s.attention.find(x => x.dealId === id);
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const first = current();
  assert.ok(first, 'qualified deal is visible');
  assert.equal(first.nextActivityAt, earlier, 'the first array position is not an ordering rule');
  assert.equal(first.hasNext, true);
  assert.equal(first.nextOverdue, false);
  const firstRisk = first.riskScore;

  // Next activity is overdue but ACTIVITY_TIME is still in the future.
  // Selecting the later field would incorrectly hide an overdue action.
  const overdue = at(-1);
  deal = { ...deal, DATE_MODIFY: at(-0.005), NEXT_ACTIVITY_TIME: overdue };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const second = current();
  assert.ok(second);
  assert.equal(second.nextActivityAt, overdue);
  assert.equal(second.hasNext, false);
  assert.equal(second.nextOverdue, true);
  assert.match(second.nextStep, /Просрочено следующее действие/);
  assert.ok(second.riskScore >= firstRisk + 40);
  assert.equal(second.scoreHistory.length, 2);
  assert.equal(calls, 2, 'no additional CRM reads or writes');
});
