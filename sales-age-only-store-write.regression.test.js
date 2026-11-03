'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('read-only dashboard age diagnostics do not trigger redundant Sheet writes', async t => {
  const saved = {
    fetch: global.fetch,
    setTimeout: global.setTimeout,
    now: Date.now,
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = saved.fetch;
    global.setTimeout = saved.setTimeout;
    Date.now = saved.now;
    for (const key of ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // Both transports are mocked: no actual CRM, Sheet, Render or mail traffic.
  const sheetUrl = 'https://sheets.example.test/sales';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  process.env.GOOGLE_SHEET_STORE_URL = sheetUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = 'local-test-only';
  const baseNow = saved.now();
  Date.now = () => baseNow;
  const scheduled = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 2500) {
      scheduled.push(() => fn(...args));
      return { unref() {} };
    }
    return saved.setTimeout(fn, ms, ...args);
  };
  const id = '99934819';
  const day = 86400000;
  const version = new Date(baseNow - 60000).toISOString();
  const deal = {
    ID: id, TITLE: 'No redundant store writes on age-only reads',
    CATEGORY_ID: '0', STAGE_ID: 'C1:ACTIVE', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(baseNow - day).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(baseNow - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(baseNow + 20 * day).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  const writes = [];
  let crmReads = 0;
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.deal.get.json')) {
      assert.equal(options.method, 'POST');
      crmReads += 1;
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (url === sheetUrl) {
      const body = JSON.parse(options.body);
      assert.equal(body.action, 'upsert');
      writes.push(body.rows);
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    throw new Error('Unexpected mocked transport: ' + url);
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  assert.equal(scheduled.length, 1, 'first trusted event must persist its score observation');
  scheduled[0]();
  await new Promise(resolve => saved.setTimeout(resolve, 0));
  assert.equal(writes.length, 1);
  const first = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(first && first.scoreHistory.length === 1);

  // Age diagnostics advance by two days, but no score, status, Next Step or
  // historical event changes. Rendering must not queue an external write.
  Date.now = () => baseNow + 2 * day;
  const after = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(after);
  assert.equal(after.prospectScore, first.prospectScore);
  assert.equal(after.riskScore, first.riskScore);
  assert.deepEqual(after.scoreHistory, first.scoreHistory);
  assert.equal(after.sourceUpdatedAt, version);
  assert.ok(after.dealAgeDays >= first.dealAgeDays + 1.9);
  assert.ok(after.lastActivityAgeDays >= first.lastActivityAgeDays + 1.9);
  assert.equal(scheduled.length, 1,
    'age-only status GET must not schedule a redundant external persistence request');
  assert.equal(writes.length, 1);
  assert.equal(crmReads, 1);
});
