'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('equal-version activity events retain sub-millisecond advances to contact and Next Step', async t => {
  // Network-free mock of the real active Sales event path. Bitrix may update
  // activity timestamps without advancing the parent deal DATE_MODIFY.
  const oldFetch = global.fetch;
  const oldEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const sales = require('./sales');
  const id = '85610997';
  const base = delta => new Date(Date.now() + delta).toISOString()
    .replace(/\.\d{3}Z$/, '.123100Z');
  const later = value => value.replace('.123100Z', '.123900Z');
  const modifiedAt = new Date(Date.now() - 3600000).toISOString();
  const oldLast = base(-2 * 3600000);
  const oldNext = base(3 * 3600000);
  const deal = {
    ID: id, TITLE: 'Fractional activity provenance',
    STAGE_ID: 'C1:IN_PROGRESS', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '750000', CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(Date.now() - 20 * 86400000).toISOString(),
    DATE_MODIFY: modifiedAt,
    LAST_ACTIVITY_TIME: oldLast, ACTIVITY_TIME: oldNext,
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let readCount = 0;
  global.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    let result;
    if (path.endsWith('/crm.deal.get.json')) {
      readCount += 1;
      result = readCount === 1 ? deal : {
        ...deal, LAST_ACTIVITY_TIME: later(oldLast), ACTIVITY_TIME: later(oldNext),
      };
    } else if (path.endsWith('/crm.activity.get.json')) {
      result = { ID: '73', OWNER_TYPE_ID: '2', OWNER_ID: id };
    } else {
      throw new Error('Unexpected mocked Bitrix method: ' + path);
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  const before = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(before, 'baseline deal appears in read-only Sales Dashboard');
  assert.equal(before.lastActivityAt, oldLast);
  assert.equal(before.nextActivityAt, oldNext);
  assert.equal(Date.parse(oldLast), Date.parse(later(oldLast)));
  assert.equal(Date.parse(oldNext), Date.parse(later(oldNext)));

  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '73' });
  const after = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(after);
  assert.equal(after.sourceUpdatedAt, modifiedAt, 'parent CRM version is unchanged');
  assert.equal(after.lastActivityAt, later(oldLast),
    'valid newer contact must not be dropped inside the same millisecond');
  assert.equal(after.nextActivityAt, later(oldNext),
    'valid newer next-action schedule must not be dropped inside the same millisecond');
  assert.equal(readCount, 2);
});
