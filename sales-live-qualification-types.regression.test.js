'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('malformed Bitrix qualification and client-type fields cannot fabricate Sales scoring', async t => {
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
  const id = '9914460';
  const baseVersion = new Date(now - 60000).toISOString();
  const newVersion = new Date(now + 1000).toISOString();
  const base = {
    ID: id, TITLE: 'Verified qualification', ASSIGNED_BY_ID: '',
    STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '300000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 10 * 86400000).toISOString(),
    DATE_MODIFY: baseVersion,
    LAST_ACTIVITY_TIME: new Date(now - 86400000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let dealResponse = base;
  let listResponse = { result: [] };
  global.fetch = async input => {
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
    throw new Error('Unexpected Bitrix request: ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const trusted = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(trusted);
  assert.equal(trusted.qualificationStatus, 'Квалифицировано');
  assert.equal(trusted.clientType, 'dealer');
  assert.equal(trusted.qualificationIssue, false);

  // String(array) can turn ['Квалифицировано'] into the affirmative status;
  // String(object) and String(number) can turn invalid types into a scoring bonus.
  for (const patch of [
    { UF_CRM_AI_QUAL_STATUS: ['Квалифицировано'] },
    { UF_CRM_AI_QUAL_STATUS: { value: 'Квалифицировано' } },
    { UF_CRM_AI_CLIENT_TYPE: ['dealer'] },
    { UF_CRM_AI_CLIENT_TYPE: { value: 'dealer' } },
    { UF_CRM_AI_CLIENT_TYPE: 7 },
  ]) {
    dealResponse = { ...base, ...patch, DATE_MODIFY: newVersion, TITLE: 'Untrusted qualification' };
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
    const state = sales.status();
    assert.equal(state.lastError?.source, 'sales-event',
      'unexpected Bitrix field types must fail closed');
    const row = state.prospects.find(item => item.dealId === id);
    assert.ok(row);
    assert.equal(row.title, trusted.title);
    assert.equal(row.sourceUpdatedAt, baseVersion);
    assert.equal(row.prospectScore, trusted.prospectScore);
    assert.equal(row.qualificationStatus, trusted.qualificationStatus);
    assert.equal(row.clientType, trusted.clientType);
    assert.equal(row.scoreHistory.length, trusted.scoreHistory.length);
  }

  listResponse = {
    result: [{ ...base, DATE_MODIFY: newVersion, UF_CRM_AI_QUAL_STATUS: ['Квалифицировано'] }],
  };
  await scheduledSync();
  assert.equal(sales.status().lastError?.source, 'sales-sync');
  assert.equal(sales.status().lastSyncAt, null);

  dealResponse = {
    ...base, DATE_MODIFY: newVersion, TITLE: 'Legitimate requalification',
    UF_CRM_AI_CLIENT_TYPE: '', UF_CRM_AI_QUAL_STATUS: 'Не квалифицировано',
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const updated = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(updated);
  assert.equal(updated.sourceUpdatedAt, newVersion);
  assert.equal(updated.qualificationStatus, 'Не квалифицировано');
  assert.equal(updated.clientType, '');
  assert.ok(updated.prospectScore < trusted.prospectScore);
  assert.equal(updated.qualificationIssue, true);
  assert.equal(updated.scoreHistory.length, trusted.scoreHistory.length + 1);
  assert.equal(sales.status().lastError?.source, 'sales-sync');

  // Bitrix sometimes represents an unset custom field as false. It must
  // remain a valid empty value, not turn a healthy CRM read into an error.
  dealResponse = {
    ...base, DATE_MODIFY: new Date(now + 2000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: false, UF_CRM_AI_QUAL_STATUS: false,
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const empty = sales.status().prospects.find(row => row.dealId === id);
  assert.ok(empty);
  assert.equal(empty.clientType, '');
  assert.equal(empty.qualificationStatus, '');
  assert.ok(empty.prospectScore < updated.prospectScore);
  assert.equal(sales.status().lastError?.source, 'sales-sync');

  listResponse = { result: [] };
  await scheduledSync();
  assert.ok(sales.status().lastSyncAt);
  assert.equal(sales.status().lastError, null);
});
