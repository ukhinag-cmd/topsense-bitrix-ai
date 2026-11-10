'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Mock-only regression. No live Bitrix, Sheets, Render or outgoing messages.
// A deadline can cross the five-minute grace boundary *between* two
// Date.now() reads. Next Step must never be both scheduled and overdue.
test('Next Step grace cutoff is consistent within one score evaluation', async t => {
  const oldFetch = global.fetch;
  const oldNow = Date.now;
  const env = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = oldFetch;
    Date.now = oldNow;
    for (const [key, val] of Object.entries(env)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const start = oldNow();
  const graceBoundary = start + 60 * 60 * 1000;
  const nextAt = new Date(graceBoundary - 5 * 60 * 1000 + 1).toISOString();
  const id = '99908112';
  const deal = {
    ID: id, TITLE: 'Grace boundary', ASSIGNED_BY_ID: '0',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '300000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(start - 86400000).toISOString(),
    DATE_MODIFY: new Date(start - 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(start - 60000).toISOString(),
    ACTIVITY_TIME: nextAt,
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let reads = 0;
  global.fetch = async input => {
    assert.match(new URL(String(input)).pathname, /\/crm\.deal\.get\.json$/);
    reads += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };
  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const initial = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(initial);
  assert.equal(initial.hasNext, true);
  assert.equal(initial.nextOverdue, false);

  // scoreDeal first measures two age fields, then checks the scheduled and
  // overdue sides of the same grace threshold. Force the clock to advance
  // two milliseconds between those reads without any CRM activity.
  let clockReads = 0;
  Date.now = () => (++clockReads <= 3 ? graceBoundary : graceBoundary + 2);
  const after = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(after);
  assert.ok(clockReads >= 3);
  assert.equal(after.hasNext, true, 'deadline is inside grace when scored');
  assert.equal(after.nextOverdue, false, 'one evaluation cannot mark it overdue too');
  assert.equal(reads, 1, 'Dashboard scoring never performs additional CRM reads');
});
