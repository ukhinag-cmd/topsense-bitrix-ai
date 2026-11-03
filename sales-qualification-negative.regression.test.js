'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const previousFetch = global.fetch;
const previousBase = process.env.BITRIX_WEBHOOK_BASE;
process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example/rest/test/';
const sales = require('./sales');

test('negative or pending qualification is not scored as completed qualification', async t => {
  t.after(() => {
    global.fetch = previousFetch;
    if (previousBase === undefined) delete process.env.BITRIX_WEBHOOK_BASE;
    else process.env.BITRIX_WEBHOOK_BASE = previousBase;
  });
  const now = new Date().toISOString();
  const base = {
    TITLE: 'Qualification regression',
    ASSIGNED_BY_ID: '',
    SOURCE_ID: 'WEB',
    CATEGORY_ID: '0',
    STAGE_ID: 'C1:IN_PROGRESS',
    STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '1000000',
    CURRENCY_ID: 'RUB',
    DATE_CREATE: new Date(Date.now() - 2 * 86400000).toISOString(),
    DATE_MODIFY: now,
    LAST_ACTIVITY_TIME: now,
    UF_CRM_AI_CLIENT_TYPE: 'dealer',
  };
  const deals = new Map([
    ['8984101', { ...base, ID: '8984101', UF_CRM_AI_QUAL_STATUS: 'Квалифицировано' }],
    ['8984102', { ...base, ID: '8984102', UF_CRM_AI_QUAL_STATUS: 'Не квалифицировано' }],
    ['8984103', { ...base, ID: '8984103', UF_CRM_AI_QUAL_STATUS: 'Дисквалифицировано' }],
    ['8984104', { ...base, ID: '8984104', UF_CRM_AI_QUAL_STATUS: 'Нужно уточнить' }],
  ]);
  global.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!path.endsWith('/crm.deal.get.json')) throw new Error('Unexpected Bitrix method: ' + path);
    const id = String(JSON.parse(init.body).ID);
    if (!deals.has(id)) throw new Error('Unknown mocked deal: ' + id);
    return { ok: true, status: 200, json: async () => ({ result: deals.get(id) }) };
  };
  for (const dealId of deals.keys()) {
    await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId });
  }
  const all = new Map(
    [...sales.status().prospects, ...sales.status().attention].map(row => [row.dealId, row])
  );
  const qualified = all.get('8984101');
  assert.ok(qualified);
  assert.equal(qualified.prospectScore, 95);
  assert.equal(qualified.qualificationIssue, false);
  for (const dealId of ['8984102', '8984103', '8984104']) {
    const row = all.get(dealId);
    assert.ok(row, dealId);
    assert.equal(row.prospectScore, 83, dealId);
    assert.equal(row.qualificationIssue, true, dealId);
    assert.equal(row.scoreHistory.length, 1, dealId);
  }
});
