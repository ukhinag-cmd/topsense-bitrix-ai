'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('manager lookup recovers from transient and mismatched user responses without changing the deal version', async t => {
  const previousFetch = global.fetch;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const sales = require('./sales');
  const id = '9900178';
  const version = new Date(Date.now() - 60000).toISOString();
  const deal = {
    ID: id,
    TITLE: 'Manager recovery without deal edit',
    ASSIGNED_BY_ID: '7',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '750000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(Date.now() - 86400000).toISOString(),
    DATE_MODIFY: version,
    LAST_ACTIVITY_TIME: new Date().toISOString(),
    ACTIVITY_TIME: new Date(Date.now() + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };

  let lookups = 0;
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json')) {
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    }
    if (path.endsWith('/user.get.json')) {
      lookups += 1;
      if (lookups === 1) throw new Error('temporary user.get outage');
      const result = lookups === 2
        ? [{ ID: '8', NAME: 'Wrong manager' }]
        : [{ ID: '7', NAME: 'Recovered', LAST_NAME: 'Manager' }];
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
    throw new Error('Unexpected CRM request: ' + path);
  };

  const event = { event: 'ONCRMDEALUPDATE', dealId: id };
  await sales.handleEvent(event);
  let row = sales.status().prospects.find(x => x.dealId === id);
  assert.ok(row);
  assert.equal(row.manager, '#7', 'temporary failure must fall back to ID');
  assert.equal(row.scoreHistory.length, 1);

  await sales.handleEvent(event);
  row = sales.status().prospects.find(x => x.dealId === id);
  assert.equal(row.manager, '#7', 'a different user ID must not be assigned to the deal');

  await sales.handleEvent(event);
  row = sales.status().prospects.find(x => x.dealId === id);
  assert.equal(lookups, 3, 'the failed and mismatched responses must remain retryable');
  assert.equal(row.manager, 'Recovered Manager', 'manager label should refresh without DATE_MODIFY change');
  assert.equal(row.sourceUpdatedAt, version);
  assert.equal(row.title, deal.TITLE);
  assert.equal(row.scoreHistory.length, 1, 'manager-only correction must not invent a scoring event');
});
