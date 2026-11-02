'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Dashboard exposes recent score history for open, won and lost deals without unsafe HTML', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const savedEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/read-only/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now();
  const ids = ['9989821', '9989822', '9989823'];
  const semantics = ['F', 'S', 'P'];
  const rows = Object.fromEntries(ids.map((id, i) => [id, {
    ID: id,
    TITLE: i === 0 ? '<img src=x onerror=alert(1)>' : 'History deal ' + id,
    ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:STAGE_' + i,
    STAGE_SEMANTIC_ID: semantics[i],
    OPPORTUNITY: '75000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: new Date(now - (3 - i) * 60000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  }]));

  const requested = [];
  global.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.ok(path.endsWith('/crm.deal.get.json'), 'only mocked read-only CRM methods');
    const id = String(JSON.parse(options.body).ID);
    requested.push(id);
    return { ok: true, status: 200, json: async () => ({ result: rows[id] }) };
  };

  const sales = require('./sales');
  for (const id of ids) {
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  }
  const state = sales.status();
  assert.deepEqual(requested, ids);
  assert.equal(state.counts.tracked, 3);
  assert.equal(state.counts.won, 1);
  assert.ok(Array.isArray(state.recentHistory), 'history must be available in read-only /sales/status');
  assert.deepEqual(state.recentHistory.map(entry => entry.dealId), [...ids].reverse(),
    'newest observations must appear first, including closed-lost deals');
  assert.equal(state.recentHistory.find(entry => entry.dealId === ids[0]).semantic, 'F');

  const html = sales.html();
  assert.ok(html.includes('История оценок'), 'score history must be visible on the Dashboard');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'),
    'history must escape untrusted deal titles');
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false,
    'history must not render executable CRM-provided markup');
});
