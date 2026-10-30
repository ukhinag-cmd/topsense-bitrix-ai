'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Sales refuses coerced Bitrix IDs and persisted array identities before attribution', async () => {
  const now = new Date().toISOString();
  const storeUrl = 'https://store.example.test/scalar-identities';
  let userRows = [{ ID: ['7'], NAME: 'Unverified', LAST_NAME: 'User' }];
  let managerReads = 0;
  const validStored = {
    kind: 'salesDeal', dealId: '9912301', title: 'Verified persisted deal',
    managerId: '7', manager: 'Verified Manager', sourceUpdatedAt: now, updatedAt: now,
    stageId: 'NEW', semantic: 'P', open: true,
    amount: 100000, currency: 'RUB', createdAt: now, lastActivityAt: now,
    nextActivityAt: new Date(Date.now() + 3600000).toISOString(),
    hasNext: true, prospectScore: 75, riskScore: 10,
    qualificationIssue: false, nextStep: 'Следующее действие запланировано',
    scoreHistory: [], alerts: [],
  };
  const storedRows = [
    { key: 'sales:deal:9912302', payload: {
      ...validStored, dealId: ['9912302'], title: 'Malformed array identity',
    } },
    { key: 'sales:deal:9912301', payload: validStored },
  ];
  const context = {
    module: { exports: {} },
    process: { env: {
      BITRIX_WEBHOOK_BASE: 'https://bitrix.example.test/rest/test/',
      GOOGLE_SHEET_STORE_URL: storeUrl,
      GOOGLE_SHEET_STORE_SECRET: 'mock-only',
    } },
    URL, AbortSignal, console,
    fetch: async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/user.get.json')) {
        managerReads += 1;
        assert.equal(JSON.parse(options.body).ID, 7);
        return { ok: true, status: 200, json: async () => ({ result: userRows }) };
      }
      if (url === storeUrl) {
        assert.equal(JSON.parse(options.body).action, 'load');
        return { ok: true, status: 200, text: async () => JSON.stringify({ rows: storedRows }) };
      }
      throw new Error('Unexpected mocked network request: ' + url);
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__testIdentity = {validDealId, validateDealRow, validateActivityRow, managerName, loadPersisted, SALES};',
    context, { filename: 'sales.js' });
  const { validDealId, validateDealRow, validateActivityRow, managerName, loadPersisted, SALES } =
    context.module.exports.__testIdentity;

  assert.equal(validDealId('941002'), true);
  assert.equal(validDealId(941002), true);
  for (const malformed of [['941002'], { id: '941002' }, true, ' 941002 ']) {
    assert.equal(validDealId(malformed), false, 'only a canonical scalar ID can identify a CRM row');
  }
  const deal = { ID: '941002', DATE_MODIFY: now, OPPORTUNITY: '250000', CURRENCY_ID: 'RUB' };
  assert.equal(validateDealRow(deal, '941002'), deal);
  assert.throws(() => validateDealRow({ ...deal, ID: ['941002'] }, '941002'),
    /Invalid Bitrix deal record/, 'an array ID must not pass a matching crm.deal.get response');

  const activity = { ID: '71245', OWNER_TYPE_ID: 2, OWNER_ID: '941002' };
  assert.equal(validateActivityRow(activity, '71245'), activity);
  for (const malformed of [
    { ...activity, ID: ['71245'] },
    { ...activity, OWNER_TYPE_ID: ['2'] },
    { ...activity, OWNER_ID: ['941002'] },
  ]) {
    assert.throws(() => validateActivityRow(malformed, '71245'), /Invalid Bitrix activity/,
      'coerced activity and owner references must be rejected');
  }

  assert.equal(await managerName('7'), '#7',
    'user.get ID as array must not identify a manager or poison the cache');
  userRows = [{ ID: 7, NAME: 'Verified', LAST_NAME: 'Manager' }];
  assert.equal(await managerName('7'), 'Verified Manager',
    'a later verified manager result must still recover');
  assert.equal(managerReads, 2);

  await loadPersisted();
  assert.equal(SALES.deals.size, 1,
    'Google Sheet row with an array dealId must not hydrate a Sales snapshot');
  assert.equal(SALES.deals.has('9912301'), true);
  assert.equal(SALES.deals.has('9912302'), false);
});
