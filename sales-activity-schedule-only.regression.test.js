'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('new scheduled activity updates Next Step at unchanged deal version without rolling back contact', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalSetTimeout(fn, ms, ...args);
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const sales = require('./sales');
  const now = Date.now();
  const id = '85903321';
  const version = new Date(now - 3600000).toISOString();
  const recentContact = new Date(now - 2 * 3600000).toISOString();
  const staleContact = new Date(now - 8 * 86400000).toISOString();
  const advancedContact = new Date(now - 30 * 60000).toISOString();
  const futureNext = new Date(now + 4 * 3600000).toISOString();
  const olderNext = new Date(now + 2 * 3600000).toISOString();
  const base = {
    ID: id,
    TITLE: 'Trusted deal title',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 2 * 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: recentContact,
    ACTIVITY_TIME: null,
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const scheduled = {
    ...base,
    TITLE: 'Stale deal title',
    OPPORTUNITY: '1',
    LAST_ACTIVITY_TIME: staleContact,
    ACTIVITY_TIME: futureNext,
  };
  const contactOnly = {
    ...scheduled,
    LAST_ACTIVITY_TIME: advancedContact,
    ACTIVITY_TIME: olderNext,
  };
  const stale = {
    ...scheduled,
    ACTIVITY_TIME: null,
  };
  const versions = [base, scheduled, contactOnly, stale];
  let dealReads = 0;
  const calls = [];

  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    let result;
    if (path.endsWith('/crm.deal.get.json')) {
      result = versions[Math.min(dealReads++, versions.length - 1)];
    } else if (path.endsWith('/crm.activity.get.json')) {
      result = { ID: JSON.parse(options.body).id, OWNER_TYPE_ID: 2, OWNER_ID: id };
    } else if (path.endsWith('/user.get.json')) {
      result = [{ ID: 7, NAME: 'Sales', LAST_NAME: 'Manager' }];
    } else {
      throw new Error('Unexpected Bitrix REST call: ' + path);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const first = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(first);
  assert.equal(first.nextActivityAt, null);
  assert.equal(first.hasNext, false);

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '31' });
  const next = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(next.nextActivityAt, futureNext, 'new scheduling must be recognized even without a new contact');
  assert.equal(next.lastActivityAt, recentContact, 'stale contact must not replace the last known contact');
  assert.equal(next.sourceUpdatedAt, version);
  assert.equal(next.title, base.TITLE, 'a contact/schedule refresh must preserve authoritative deal fields');
  assert.equal(next.amount, 1000000);
  assert.equal(next.hasNext, true);
  assert.equal(next.nextOverdue, false);
  assert.ok(next.riskScore < first.riskScore);
  assert.equal(next.scoreHistory.length, 2);

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '32' });
  const third = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(third.lastActivityAt, advancedContact, 'newer contact is permitted');
  assert.equal(third.nextActivityAt, futureNext, 'an older next-action date cannot roll back the schedule');

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '33' });
  const final = sales.status().prospects.find(row => row.dealId === id);
  assert.equal(final.lastActivityAt, advancedContact);
  assert.equal(final.nextActivityAt, futureNext);
  assert.equal(final.scoreHistory.length, 2, 'stale retries must not duplicate unchanged score history');
  assert.equal(calls.some(path => /\/(?:crm\.deal\.(?:update|delete)|batch)\.json$/.test(path)), false,
    'activity refresh must remain strictly read-only');
});
