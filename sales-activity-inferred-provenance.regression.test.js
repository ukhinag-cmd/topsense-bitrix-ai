'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('activity-only update must not turn a persisted inferred outcome into a direct CRM semantic', async t => {
  // All CRM and Sheets requests below are mock responses, never production.
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
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  process.env.GOOGLE_SHEET_STORE_URL = 'https://store.example.test/sales';
  process.env.GOOGLE_SHEET_STORE_SECRET = 'mock-secret';
  let scheduledSync;
  global.setTimeout = (fn, delay, ...args) => {
    if (delay === 5000) {
      scheduledSync = () => fn(...args);
      return { unref() {} };
    }
    if (delay === 2500) return { unref() {} };
    return originalTimeout(fn, delay, ...args);
  };
  global.setInterval = (fn, delay, ...args) =>
    delay === 120000 ? { unref() {} } : originalInterval(fn, delay, ...args);

  const id = '99870061';
  const activityId = '99870062';
  const now = Date.now();
  const version = new Date(now - 3 * 3600000).toISOString();
  const createdAt = new Date(now - 3 * 86400000).toISOString();
  const newContact = new Date(now - 30 * 60000).toISOString();
  const persisted = {
    kind: 'salesDeal', dealId: id, title: 'Previously verified win',
    managerId: '', manager: 'Manager', sourceId: '', categoryId: '0',
    stageId: 'C1:CLOSED', stageName: 'Закрыта',
    semantic: 'S', sourceStageSemantic: '', stageSemanticKnown: true, open: false,
    amount: 0, currency: 'RUB', updatedAt: version, sourceUpdatedAt: version,
    modifiedAt: version, createdAt, stageEnteredAt: version,
    lastActivityAt: null, nextActivityAt: null, hasNext: false,
    nextStep: 'Сделка завершена успешно', qualificationIssue: false,
    qualificationStatus: '', clientType: '', prospectScore: 5, riskScore: 0,
    scoreHistory: [{
      at: version, categoryId: '0', stageId: 'C1:CLOSED',
      semantic: 'S', stageName: 'Закрыта', amount: 0, currency: 'RUB',
      prospectScore: 5, riskScore: 0,
    }],
    alerts: [],
  };

  let stageReads = 0;
  global.fetch = async (input, options = {}) => {
    assert.equal(options.method, 'POST');
    const url = String(input);
    const path = new URL(url).pathname;
    if (url === process.env.GOOGLE_SHEET_STORE_URL) {
      assert.equal(JSON.parse(options.body).action, 'load');
      return { ok: true, status: 200, text: async () =>
        JSON.stringify({ rows: [{ key: 'sales:deal:' + id, payload: persisted }] }) };
    }
    if (path.endsWith('/crm.status.list.json')) {
      stageReads += 1;
      return { ok: true, status: 200, json: async () => ({
        result: stageReads === 1 ? { malformed: true } : [
          { STATUS_ID: 'C1:CLOSED', NAME: 'Закрыта без продажи', SEMANTICS: 'F' },
        ],
      }) };
    }
    if (path.endsWith('/crm.activity.get.json')) {
      assert.equal(String(JSON.parse(options.body).id), activityId);
      return { ok: true, status: 200, json: async () => ({
        result: { ID: activityId, OWNER_TYPE_ID: 2, OWNER_ID: id },
      }) };
    }
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({
        result: {
          ID: id, TITLE: 'Untrusted equal-version title',
          CATEGORY_ID: '0', STAGE_ID: 'C1:CLOSED',
          // This is NOT an explicit Bitrix stage semantic.
          OPPORTUNITY: '0', CURRENCY_ID: 'RUB', DATE_CREATE: createdAt,
          DATE_MODIFY: version, LAST_ACTIVITY_TIME: newContact,
        },
      }) };
    }
    if (path.endsWith('/crm.deal.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [], total: 0 }) };
    }
    throw new Error('Unexpected mock request ' + path);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(sales.status().counts.won, 1);
  assert.equal(stageReads, 1, 'the startup stage dictionary was unavailable');

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId });
  const afterActivity = sales.status().wins[0];
  assert.ok(afterActivity, 'the last verified win survives the temporary stage outage');
  assert.equal(afterActivity.lastActivityAt, newContact);
  assert.equal(afterActivity.sourceUpdatedAt, version);
  assert.equal(afterActivity.title, persisted.title, 'equal-version activity cannot replace deal title');
  assert.equal(afterActivity.sourceStageSemantic, '',
    'an inferred cached S must not be persisted as if Bitrix supplied S directly');

  await scheduledSync();
  const afterRecovery = sales.status();
  assert.equal(stageReads, 2);
  assert.equal(afterRecovery.counts.won, 0);
  assert.equal(afterRecovery.counts.open, 0);
  assert.equal(afterRecovery.wins.length, 0,
    'the newly verified lost-stage dictionary must supersede an old inferred win');
});
