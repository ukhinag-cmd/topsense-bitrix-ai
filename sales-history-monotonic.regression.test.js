'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a delayed CRM update cannot put Sales score history before an already recorded temporal score', async t => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    Date.now = originalNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const now = originalNow();
  const minute = 60000;
  const day = 86400000;
  const id = '9920017';
  let deal = {
    ID: id,
    TITLE: 'Historical scoring order',
    ASSIGNED_BY_ID: '',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 90 * day).toISOString(),
    DATE_MODIFY: new Date(now - 120 * minute).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 16 * day).toISOString(),
    ACTIVITY_TIME: new Date(now + 30 * minute).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let reads = 0;
  global.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    assert.ok(path.endsWith('/crm.deal.get.json'), 'mocked read-only deal reads only');
    reads += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  let row = sales.status().prospects.find(item => item.dealId === id);
  assert.ok(row);
  assert.equal(row.scoreHistory.length, 1);
  assert.equal(row.hasNext, true);

  // CRM has not changed, but the scheduled action becomes overdue. The
  // dashboard appends a time-based score observation after the old CRM version.
  Date.now = () => now + 100 * minute;
  row = sales.status().prospects.find(item => item.dealId === id);
  assert.ok(row);
  assert.equal(row.hasNext, false);
  assert.equal(row.scoreHistory.length, 2);
  const observedAt = Date.parse(row.scoreHistory[1].at);
  assert.ok(observedAt > Date.parse(row.scoreHistory[0].at));

  // A legitimate newer CRM version can still be earlier than this local
  // observation (delayed webhook / sync). Its score must append at a
  // nondecreasing history timestamp, without rewriting sourceUpdatedAt.
  Date.now = originalNow;
  const version = new Date(now - 30 * minute).toISOString();
  deal = {
    ...deal,
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date(now - day).toISOString(),
    ACTIVITY_TIME: new Date(now + 150 * minute).toISOString(),
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  row = sales.status().prospects.find(item => item.dealId === id);
  assert.ok(row);
  assert.equal(reads, 2);
  assert.equal(row.sourceUpdatedAt, version, 'CRM version stays authoritative');
  assert.equal(row.hasNext, true);
  assert.equal(row.scoreHistory.length, 3);
  const times = row.scoreHistory.map(entry => Date.parse(entry.at));
  assert.ok(times.every(Number.isFinite));
  assert.ok(times.every((at, i) => i === 0 || at >= times[i - 1]),
    'score history must be chronological even when a webhook arrives late');
});

test('temporal risk history cannot predate an accepted near-future CRM modification', async t => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const originalEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    Date.now = originalNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const now = originalNow();
  const minute = 60000;
  const id = '9920018';
  const sourceVersion = new Date(now + 5 * minute).toISOString();
  const deal = {
    ID: id,
    TITLE: 'Clock skew history order',
    ASSIGNED_BY_ID: '',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 90 * 86400000).toISOString(),
    DATE_MODIFY: sourceVersion,
    LAST_ACTIVITY_TIME: new Date(now - 16 * 86400000).toISOString(),
    ACTIVITY_TIME: new Date(now + 30 * minute).toISOString(),
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  let reads = 0;
  global.fetch = async input => {
    assert.ok(new URL(String(input)).pathname.endsWith('/crm.deal.get.json'));
    reads += 1;
    return { ok: true, status: 200, json: async () => ({ result: deal }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  let row = sales.status().prospects.find(item => item.dealId === id);
  assert.ok(row);
  assert.equal(row.sourceUpdatedAt, sourceVersion);
  assert.equal(row.scoreHistory.length, 1);
  assert.equal(row.scoreHistory[0].at, sourceVersion);
  assert.equal(row.hasNext, true);

  // A source timestamp five minutes ahead is within the accepted clock-skew
  // window. The dashboard must not append a backward time-based score point.
  Date.now = () => now + 100 * minute;
  row = sales.status().prospects.find(item => item.dealId === id);
  assert.ok(row);
  assert.equal(row.hasNext, false);
  assert.equal(row.scoreHistory.length, 2);
  assert.ok(Date.parse(row.scoreHistory[1].at) >= Date.parse(row.scoreHistory[0].at));
  assert.equal(row.sourceUpdatedAt, sourceVersion);
  assert.equal(reads, 1, 'temporal evaluation must not write to or re-read Bitrix');
});
