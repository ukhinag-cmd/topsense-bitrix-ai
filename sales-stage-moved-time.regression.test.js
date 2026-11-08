'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Mock-only: never contact a real Bitrix portal, Sheets or Render.
test('verified MOVED_TIME preserves true stage age across later deal edits and rejects corrupt chronology', async t => {
  const originalFetch = global.fetch;
  const env = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const day = 86400000;
  const now = Date.now();
  const at = days => new Date(now + days * day).toISOString();
  const id = '9988951';
  let deal = {
    ID: id, TITLE: 'Qualified opportunity', CATEGORY_ID: '0',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P', ASSIGNED_BY_ID: '',
    OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: at(-80), DATE_MODIFY: at(-1), MOVED_TIME: at(-22),
    LAST_ACTIVITY_TIME: at(-1), ACTIVITY_TIME: at(2),
    UF_CRM_AI_CLIENT_TYPE: 'dealer', UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let reads = 0;
  global.fetch = async (input, options = {}) => {
    assert.match(new URL(String(input)).pathname, /\/crm\.deal\.get\.json$/,
      'only the explicitly mocked read-only deal endpoint may be called');
    assert.equal(String(JSON.parse(options.body || '{}').ID), id);
    reads += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  const sales = require('./sales');
  const get = () => {
    const status = sales.status();
    return status.prospects.find(row => row.dealId === id) ||
      status.attention.find(row => row.dealId === id);
  };
  const event = { event: 'ONCRMDEALUPDATE', dealId: id };

  await sales.handleEvent(event);
  const first = get();
  assert.ok(first);
  assert.equal(first.stageEnteredAt, at(-22), 'actual stage change predates the recent DATE_MODIFY');
  assert.equal(first.riskScore, 43, '22-day stage age contributes 25 Risk points');
  assert.equal(first.stageAgeDays > 20, true);

  deal = { ...deal, STAGE_ID: 'IN_PROGRESS', DATE_MODIFY: at(-0.5), MOVED_TIME: at(-11) };
  await sales.handleEvent(event);
  const moved = get();
  assert.equal(moved.stageId, 'IN_PROGRESS');
  assert.equal(moved.stageEnteredAt, at(-11), 'delayed move uses CRM-proven stage transition');
  assert.equal(moved.riskScore, 33);

  deal = { ...deal, TITLE: 'Later unrelated edit', DATE_MODIFY: at(-0.25) };
  await sales.handleEvent(event);
  const edited = get();
  assert.equal(edited.title, 'Later unrelated edit');
  assert.equal(edited.stageEnteredAt, at(-11), 'unrelated edit cannot reset stage age');
  assert.equal(edited.riskScore, 33);
  const trustedVersion = edited.sourceUpdatedAt;
  const historyLength = edited.scoreHistory.length;

  for (const badMovedTime of [
    at(-5).replace(/Z$/, ''),
    at(-5).slice(0, 10),
    at(-0.125), // Stage movement cannot be later than DATE_MODIFY.
  ]) {
    deal = { ...deal, DATE_MODIFY: at(-0.2), MOVED_TIME: badMovedTime,
      STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S' };
    await sales.handleEvent(event);
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event', 'bad MOVED_TIME must reject the CRM row');
    assert.equal(state.counts.won, 0, 'bad MOVED_TIME cannot fabricate a won deal');
    const current = get();
    assert.equal(current.title, edited.title);
    assert.equal(current.sourceUpdatedAt, trustedVersion);
    assert.equal(current.stageEnteredAt, at(-11));
    assert.equal(current.scoreHistory.length, historyLength);
  }

  deal = { ...deal, DATE_MODIFY: at(-0.1), MOVED_TIME: null,
    STAGE_ID: 'PROPOSAL', STAGE_SEMANTIC_ID: 'P' };
  await sales.handleEvent(event);
  const fallback = get();
  assert.equal(fallback.stageEnteredAt, at(-0.1),
    'legacy deals without MOVED_TIME retain the existing DATE_MODIFY fallback');
  assert.equal(sales.status().lastError, null);
  assert.equal(reads, 7);
});