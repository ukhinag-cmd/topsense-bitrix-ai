'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

test('authenticated activity-update webhook refreshes an overdue Next Step through read-only Bitrix reads', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalEnv = Object.fromEntries(
    ['BITRIX_WEBHOOK_BASE', 'GOOGLE_SHEET_STORE_URL', 'GOOGLE_SHEET_STORE_SECRET']
      .map(key => [key, process.env[key]])
  );
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Neither the mocked webhook nor subsequent CRM requests reach live services.
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now();
  const hour = 3600000;
  const day = 86400000;
  const dealId = '9988893';
  const activityId = '9988894';
  const version = new Date(now - 3 * hour).toISOString();
  const overdue = new Date(now - 2 * hour).toISOString();
  const rescheduled = new Date(now + 2 * day).toISOString();
  let nextActivity = overdue;
  const readMethods = [];

  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST', 'Bitrix REST transport is POST with read-only method names');
    const path = new URL(String(input)).pathname;
    const method = path.slice(path.lastIndexOf('/') + 1);
    readMethods.push(method);
    let result;
    if (method === 'crm.deal.get.json') {
      assert.equal(String(JSON.parse(options.body).ID), dealId);
      result = {
        ID: dealId, TITLE: 'Authenticated activity update', ASSIGNED_BY_ID: '',
        CATEGORY_ID: '0', STAGE_ID: 'C1:IN_PROGRESS', STAGE_SEMANTIC_ID: 'P',
        OPPORTUNITY: '700000', CURRENCY_ID: 'RUB',
        DATE_CREATE: new Date(now - 15 * day).toISOString(),
        DATE_MODIFY: version, LAST_ACTIVITY_TIME: new Date(now - 2 * day).toISOString(),
        ACTIVITY_TIME: nextActivity,
        UF_CRM_AI_QUAL_STATUS: 'Квалифицировано', UF_CRM_AI_CLIENT_TYPE: 'dealer',
      };
    } else if (method === 'crm.activity.get.json') {
      assert.equal(String(JSON.parse(options.body).id), activityId);
      result = { ID: activityId, OWNER_TYPE_ID: '2', OWNER_ID: dealId };
    } else {
      throw new Error('Unexpected read-only CRM method: ' + method);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId });
  const initial = sales.status().prospects.find(row => row.dealId === dealId);
  assert.ok(initial, 'baseline deal is visible to the Dashboard');
  assert.equal(initial.nextActivityAt, overdue);
  assert.equal(initial.nextOverdue, true);

  // Bitrix publishes onCrmActivityUpdate when an activity is rescheduled.
  // The event carries the activity ID, not a new DATE_MODIFY for its deal.
  nextActivity = rescheduled;
  const token = 'mock-activity-update-token';
  const event = parseBitrixEvent(JSON.stringify({
    event: 'onCrmActivityUpdate',
    data: { FIELDS: { ID: activityId } },
    auth: { application_token: token },
  }), 'application/json', token);
  assert.deepEqual(event, {
    event: 'ONCRMACTIVITYUPDATE', dealId: null, activityId,
    activityProviderId: null, activityDirection: null, activityOwnerTypeId: null,
  }, 'a valid authenticated activity-update event must not be silently discarded');

  await sales.handleEvent(event);
  const updated = sales.status().prospects.find(row => row.dealId === dealId);
  assert.ok(updated);
  assert.equal(updated.nextActivityAt, rescheduled);
  assert.equal(updated.nextOverdue, false);
  assert.equal(updated.hasNext, true);
  assert.match(updated.nextStep, /Следующее действие/);
  assert.ok(updated.riskScore < initial.riskScore,
    'rescheduling the overdue activity must reduce Risk Score');
  assert.equal(updated.sourceUpdatedAt, version,
    'an activity update must not fabricate a new CRM deal version');
  assert.deepEqual(readMethods, [
    'crm.deal.get.json', 'crm.activity.get.json', 'crm.deal.get.json',
  ], 'activity update processing must use only read-only Bitrix methods');
});
