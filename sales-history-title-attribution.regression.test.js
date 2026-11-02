'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('score history keeps the title seen at each observation after a CRM rename', async t => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const savedEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/readonly/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;
  global.setTimeout = (fn, ms, ...args) =>
    ms === 2500 ? { unref() {} } : originalTimeout(fn, ms, ...args);

  const now = Date.now();
  const id = '9989861';
  const originalTitle = 'Название до изменения';
  const renamedTitle = '<svg onload=alert(1)>Новое название';
  const base = {
    ID: id,
    ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0',
    STAGE_ID: 'NEW',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '75000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(now - 86400000).toISOString(),
    LAST_ACTIVITY_TIME: new Date(now - 3600000).toISOString(),
    ACTIVITY_TIME: new Date(now + 3600000).toISOString(),
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
    UF_CRM_AI_QUAL_STATUS: 'Квалифицировано',
  };
  let liveDeal = {
    ...base, TITLE: originalTitle,
    DATE_MODIFY: new Date(now - 120000).toISOString(),
  };
  let reads = 0;
  global.fetch = async (input, options) => {
    assert.equal(new URL(String(input)).pathname.endsWith('/crm.deal.get.json'), true);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.equal(String(JSON.parse(options.body).ID), id);
    reads += 1;
    return { ok: true, status: 200, json: async () => ({ result: { ...liveDeal } }) };
  };

  const sales = require('./sales');
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  let history = sales.status().recentHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].titleDeal, originalTitle);

  // Renaming a deal can leave the scores, stage, amount and manager unchanged.
  // An audit history must nevertheless preserve the original name and record
  // the new name instead of retroactively relabeling the old observation.
  liveDeal = {
    ...base, TITLE: renamedTitle,
    DATE_MODIFY: new Date(now - 60000).toISOString(),
  };
  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id });
  history = sales.status().recentHistory;
  assert.equal(history.length, 2, 'the real CRM title change belongs in the audit trail');
  assert.equal(history[0].titleDeal, renamedTitle);
  assert.equal(history[1].titleDeal, originalTitle);
  assert.equal(history[0].prospectScore, history[1].prospectScore);
  assert.equal(history[0].riskScore, history[1].riskScore);
  assert.equal(reads, 2, 'all CRM requests must be mock-only reads');

  const html = sales.html();
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
  assert.ok(html.includes(originalTitle));
  assert.equal(html.includes('<svg onload=alert(1)>'), false,
    'CRM titles must remain HTML-escaped in the read-only audit timeline');
});
