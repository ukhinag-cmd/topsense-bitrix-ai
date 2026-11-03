'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalEnv = {
  BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
  GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
  GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
};
process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
delete process.env.GOOGLE_SHEET_STORE_URL;
delete process.env.GOOGLE_SHEET_STORE_SECRET;

const sales = require('./sales');

function bitrixResponse(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('a late older CRM response cannot roll back a newer sub-millisecond snapshot', async t => {
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const older = {
    ID: '42',
    TITLE: 'Older snapshot',
    ASSIGNED_BY_ID: '7',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '100000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: '2026-10-01T00:00:00Z',
    DATE_MODIFY: '2026-10-29T00:00:00.123400Z',
    LAST_ACTIVITY_TIME: '2026-10-29T00:00:00Z',
    ACTIVITY_TIME: '2026-10-29T01:00:00Z',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  const newer = {
    ...older,
    TITLE: 'Newer snapshot',
    DATE_MODIFY: '2026-10-29T00:00:00.123900Z',
  };
  const latest = {
    ...newer,
    TITLE: 'Newest snapshot',
    DATE_MODIFY: '2026-10-29T00:00:00.123950Z',
  };

  let dealCalls = 0;
  let userCalls = 0;
  let signalFirstUser;
  const firstUserStarted = new Promise(resolve => { signalFirstUser = resolve; });

  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) {
      dealCalls += 1;
      return bitrixResponse(dealCalls === 1 ? older : dealCalls === 2 ? newer : latest);
    }
    if (path.endsWith('/user.get.json')) {
      userCalls += 1;
      const call = userCalls;
      if (call === 1) signalFirstUser();
      await delay(call === 1 ? 80 : 5);
      return bitrixResponse([{ ID: '7', NAME: call === 1 ? 'Slow stale manager' : 'Current manager' }]);
    }
    throw new Error('Unexpected mocked Bitrix method: ' + path);
  };

  const olderRequest = sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '42' });
  await firstUserStarted;
  const newerRequest = sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '42' });
  await Promise.all([olderRequest, newerRequest]);

  const row = sales.status().prospects.find(item => item.dealId === '42');
  assert.ok(row, 'the open qualified deal should be visible in Sales Dashboard');
  assert.equal(row.title, 'Newer snapshot');
  assert.equal(row.sourceUpdatedAt, newer.DATE_MODIFY);
  assert.equal(row.manager, 'Current manager');
  assert.equal(row.scoreHistory.length, 1, 'the stale response must not append a history entry');

  // A later event reuses the manager cache. The stale first lookup must not
  // have overwritten the name returned by the newer lookup.
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '42' });
  const finalRow = sales.status().prospects.find(item => item.dealId === '42');
  assert.equal(finalRow.title, 'Newest snapshot');
  assert.equal(finalRow.sourceUpdatedAt, latest.DATE_MODIFY);
  assert.equal(finalRow.manager, 'Current manager', 'stale user.get completion must not poison the shared manager cache');
  assert.equal(finalRow.scoreHistory.length, 1, 'title-only changes must not create a score-history entry');
});
