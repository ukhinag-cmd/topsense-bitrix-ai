'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a valid Unix epoch CRM date cannot erase deal age, overdue Next Step or score history provenance', async t => {
  const originalFetch = global.fetch;
  const env = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/mock/';
  delete process.env.GOOGLE_SHEET_STORE_URL;
  delete process.env.GOOGLE_SHEET_STORE_SECRET;

  const epoch = '1970-01-01T00:00:00.000Z';
  const recentVersion = new Date(Date.now() - 60000).toISOString();
  const base = {
    TITLE: 'Epoch provenance test', CATEGORY_ID: '0',
    STAGE_ID: 'IN_PROGRESS', STAGE_SEMANTIC_ID: 'P',
    ASSIGNED_BY_ID: '', OPPORTUNITY: '250000', CURRENCY_ID: 'RUB',
    DATE_CREATE: epoch, LAST_ACTIVITY_TIME: epoch,
    ACTIVITY_TIME: epoch, UF_CRM_AI_QUAL_STATUS: '',
    UF_CRM_AI_CLIENT_TYPE: '',
  };
  const deals = new Map([
    ['9978051', { ...base, ID: '9978051', DATE_MODIFY: recentVersion }],
    ['9978052', { ...base, ID: '9978052', DATE_MODIFY: epoch, ACTIVITY_TIME: null }],
  ]);
  const reads = [];
  global.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    assert.ok(path.endsWith('/crm.deal.get.json'), 'CRM access must remain read-only');
    const id = String(JSON.parse(options.body).ID);
    reads.push(id);
    assert.ok(deals.has(id));
    return { ok: true, status: 200, json: async () => ({ result: deals.get(id) }) };
  };

  const sales = require('./sales');
  const first = await sales.handleEvent({
    event: 'ONCRMDEALUPDATE', dealId: '9978051',
  }, { propagateError: true });
  assert.ok(first);
  assert.equal(first.createdAt, epoch, '1970 is a real observed creation date, not missing');
  assert.equal(first.lastActivityAt, epoch, 'last contact must retain its real provenance');
  assert.equal(first.nextActivityAt, epoch, 'an overdue action must not disappear');
  assert.ok(first.dealAgeDays > 1000);
  assert.ok(first.lastActivityAgeDays > 1000);
  assert.equal(first.nextOverdue, true);
  assert.match(first.nextStep, /Просрочено/);
  assert.equal(first.riskScore, 98, 'stale deal and contact plus overdue action must count toward risk');

  const second = await sales.handleEvent({
    event: 'ONCRMDEALUPDATE', dealId: '9978052',
  }, { propagateError: true });
  assert.ok(second);
  assert.equal(second.sourceUpdatedAt, epoch);
  assert.equal(second.updatedAt, epoch, 'source version must not turn into observation time');
  assert.equal(second.stageEnteredAt, epoch);
  assert.equal(second.scoreHistory[0].at, epoch, 'the first audit point preserves CRM chronology');
  assert.equal(second.riskScore, 100);

  const status = sales.status();
  assert.ok(status.attention.some(row => row.dealId === '9978051' && row.nextOverdue));
  assert.equal(status.attention.find(row => row.dealId === '9978052').sourceUpdatedAt, epoch);
  assert.deepEqual(reads, ['9978051', '9978052'], 'Dashboard reads must not contact Bitrix again');
});
