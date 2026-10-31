'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Bitrix stage semantics must be recognized and normalized before Sales scoring', async t => {
  const oldFetch = global.fetch;
  const oldTimeout = global.setTimeout;
  const oldInterval = global.setInterval;
  const oldEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = oldFetch;
    global.setTimeout = oldTimeout;
    global.setInterval = oldInterval;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let runSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      runSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return oldTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : oldInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9943557';
  const originalVersion = new Date(now - 60000).toISOString();
  const updatedVersion = new Date(now + 1000).toISOString();
  const base = {
    ID: id, TITLE: 'Trusted open deal',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '300000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    DATE_MODIFY: originalVersion,
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 86400000).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let eventDeal = base;
  let listPage = { result: [] };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    const result = path.endsWith('/crm.status.list.json')
      ? { result: [] }
      : path.endsWith('/crm.deal.get.json')
        ? { result: eventDeal }
        : path.endsWith('/crm.deal.list.json')
          ? listPage : null;
    if (!result) throw new Error('Unexpected mocked Bitrix request: ' + path);
    return { ok: true, status: 200, json: async () => result };
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted, 'trusted open deal should be visible');
  assert.equal(trusted.semantic, 'P');
  assert.equal(trusted.scoreHistory.length, 1);

  // A scalar but unrecognized direct semantic is not safe to accept: it
  // overrides the verified stage dictionary and invents an unknown state.
  for (const unknown of ['X', 'SUCCESS', 'S,F']) {
    eventDeal = { ...base, TITLE: 'Untrusted state',
      STAGE_SEMANTIC_ID: unknown, DATE_MODIFY: updatedVersion };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event', unknown);
    const row = state.prospects.find(item => item.dealId === id);
    assert.ok(row);
    assert.equal(row.title, trusted.title);
    assert.equal(row.semantic, 'P');
    assert.equal(row.sourceUpdatedAt, originalVersion);
    assert.equal(row.scoreHistory.length, 1);
  }

  // The same shared validator also guards paginated crm.deal.list pages.
  listPage = { result: [{ ...base, STAGE_SEMANTIC_ID: 'X',
    DATE_MODIFY: updatedVersion }] };
  await runSync();
  assert.equal(sales.status().lastError?.source, 'sales-sync');
  assert.equal(sales.status().lastSyncAt, null);
  assert.equal(sales.status().counts.won, 0);

  // Whitespace/casing from an intermediary can be unambiguously normalized.
  // Without normalization the first observation is ' S ', then a Dashboard
  // refresh changes it to 'S' and fabricates a second audit-history transition.
  eventDeal = { ...base, TITLE: 'Verified win',
    STAGE_ID: 'WON', STAGE_SEMANTIC_ID: ' s ',
    DATE_MODIFY: updatedVersion };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const state = sales.status();
  assert.equal(state.counts.won, 1);
  const win = state.wins.find(row => row.dealId === id);
  assert.ok(win);
  assert.equal(win.semantic, 'S');
  assert.equal(win.sourceStageSemantic, 'S');
  assert.equal(win.scoreHistory.length, 2, 'only one true P → S transition');
  assert.equal(sales.status().wins.find(row => row.dealId === id).scoreHistory.length, 2);
});
