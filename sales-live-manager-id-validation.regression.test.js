'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed assigned-manager identity cannot replace a verified Sales owner', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  let scheduledSync;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (ms === 2500) return { unref() {} };
    return originalTimeout(fn, ms, ...args);
  };
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalInterval(fn, ms, ...args);

  const now = Date.now();
  const id = '9920191';
  const version = new Date(now - 60000).toISOString();
  const nextVersion = new Date(now + 1000).toISOString();
  const base = {
    ID: id, TITLE: 'Verified owner', ASSIGNED_BY_ID: '7',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '300000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 10 * 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(now - 86400000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let dealResponse = base;
  let listResponse = { result: [] };
  const userRequests = [];
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: dealResponse }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => listResponse };
    }
    if (path.endsWith('/user.get.json')) {
      const managerId = JSON.parse(options.body).ID;
      userRequests.push(managerId);
      return { ok: true, status: 200, json: async () => ({ result:
        managerId === 7 ? [{ ID: 7, NAME: 'Verified', LAST_NAME: 'Manager' }] :
        managerId === 9 ? [{ ID: 9, NAME: 'Other', LAST_NAME: 'Manager' }] : [],
      }) };
    }
    throw new Error('Unexpected mocked request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted);
  assert.equal(trusted.managerId, '7');
  assert.equal(trusted.manager, 'Verified Manager');
  assert.equal(sales.status().lastError, null);
  const initialUserReads = userRequests.length;

  // Arrays, objects and booleans can be coerced to text/number by JavaScript.
  // An array ['9'] would otherwise identify manager #9 as the owner even
  // though Bitrix did not return a valid single-valued manager ID.
  for (const badOwner of [['9'], { id: '9' }, true]) {
    dealResponse = { ...base, TITLE: 'Unverified ownership',
      ASSIGNED_BY_ID: badOwner, DATE_MODIFY: nextVersion };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event', 'invalid manager ID must fail closed');
    const actual = state.prospects.find(row => row.dealId === id);
    assert.equal(actual.managerId, '7');
    assert.equal(actual.manager, 'Verified Manager');
    assert.equal(actual.title, trusted.title);
    assert.equal(actual.sourceUpdatedAt, version);
    assert.equal(actual.scoreHistory.length, trusted.scoreHistory.length);
  }
  assert.equal(userRequests.length, initialUserReads,
    'invalid manager IDs must not trigger an unrelated user.get lookup');

  listResponse = { result: [{ ...base, TITLE: 'Bad sync owner',
    ASSIGNED_BY_ID: ['9'], DATE_MODIFY: nextVersion }] };
  await scheduledSync();
  assert.equal(sales.status().lastError?.source, 'sales-sync');
  assert.equal(sales.status().lastSyncAt, null);
  assert.equal(sales.status().prospects.find(row => row.dealId === id).managerId, '7');

  // Genuine scalar Bitrix manager ID updates are still accepted.
  dealResponse = { ...base, TITLE: 'Verified ownership change',
    ASSIGNED_BY_ID: 9, DATE_MODIFY: nextVersion };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const verified = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(verified.managerId, '9');
  assert.equal(verified.manager, 'Other Manager');
  assert.equal(verified.title, 'Verified ownership change');
  assert.equal(sales.status().lastError?.source, 'sales-sync',
    'valid webhook must not hide a previous sync failure');

  listResponse = { result: [] };
  await scheduledSync();
  assert.ok(sales.status().lastSyncAt);
  assert.equal(sales.status().lastError, null);
});
