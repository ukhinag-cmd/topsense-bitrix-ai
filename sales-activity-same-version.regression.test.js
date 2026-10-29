'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('activity webhook refreshes contact and Next Step without a deal DATE_MODIFY change', async t => {
  const originalFetch = global.fetch;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const sales = require('./sales');
  const now = Date.now();
  const day = 86400000;
  const id = '85610091';
  const oldContact = new Date(now - 16 * day).toISOString();
  const newContact = new Date(now - 60 * 60000).toISOString();
  const oldNext = new Date(now - 4 * 3600000).toISOString();
  const newNext = new Date(now + 4 * 3600000).toISOString();
  const sourceVersion = new Date(now - 2 * 3600000).toISOString();
  const base = {
    ID: id,
    TITLE: 'Current deal title',
    ASSIGNED_BY_ID: '7',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '750000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 20 * day).toISOString(),
    DATE_MODIFY: sourceVersion,
    LAST_ACTIVITY_TIME: oldContact,
    ACTIVITY_TIME: oldNext,
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  const activityChanged = {
    ...base,
    TITLE: 'Stale same-version title must not win',
    OPPORTUNITY: '1',
    LAST_ACTIVITY_TIME: newContact,
    ACTIVITY_TIME: newNext,
  };
  let reads = 0;
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    let result;
    if (path.endsWith('/crm.deal.get.json')) {
      reads += 1;
      result = reads === 2 ? activityChanged : base;
    } else if (path.endsWith('/crm.activity.get.json')) {
      result = { ID: JSON.parse(options.body).id, OWNER_TYPE_ID: 2, OWNER_ID: id };
    } else if (path.endsWith('/user.get.json')) {
      result = [{ ID: 7, NAME: 'Sales', LAST_NAME: 'Manager' }];
    } else {
      throw new Error('Unexpected Bitrix method: ' + path);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const previous = sales.status().attention.find(x => x.dealId === id);
  assert.ok(previous, 'stale contact and overdue action should be flagged');
  assert.equal(previous.nextOverdue, true);

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '71' });
  const updated = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(updated);
  assert.equal(updated.sourceUpdatedAt, sourceVersion, 'source version should not be fabricated');
  assert.equal(updated.lastActivityAt, newContact, 'newer activity must not be dropped at equal DATE_MODIFY');
  assert.equal(updated.nextActivityAt, newNext);
  assert.equal(updated.nextOverdue, false);
  assert.equal(updated.hasNext, true);
  assert.ok(updated.riskScore < previous.riskScore);
  assert.equal(updated.title, base.TITLE, 'activity-only refresh must not roll back unrelated deal fields');
  assert.equal(updated.amount, 750000);
  assert.equal(updated.scoreHistory.length, 2);

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '72' });
  const finalRow = sales.status().prospects.find(x => x.dealId === id);
  assert.equal(finalRow.lastActivityAt, newContact, 'later stale activity response cannot roll back the contact');
  assert.equal(finalRow.nextActivityAt, newNext);
  assert.equal(finalRow.scoreHistory.length, 2, 'stale activity does not add history');
});
