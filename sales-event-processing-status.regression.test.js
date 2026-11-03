'use strict';

// Offline regression for the independently exposed event-processing health.
// HTTP receipt is not proof that Bitrix read-only synchronization succeeded.
const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales status distinguishes processed, failed and ignored Bitrix events', async t => {
  const oldFetch = global.fetch;
  const oldEnv = process.env.BITRIX_WEBHOOK_BASE;
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test-only/';
  t.after(() => {
    global.fetch = oldFetch;
    if (oldEnv === undefined) delete process.env.BITRIX_WEBHOOK_BASE;
    else process.env.BITRIX_WEBHOOK_BASE = oldEnv;
  });

  const id = '9919961';
  const now = new Date(Date.now() - 60000).toISOString();
  const created = new Date(Date.now() - 86400000).toISOString();
  const deal = {
    ID: id, TITLE: 'Verified read-only event', ASSIGNED_BY_ID: '',
    CATEGORY_ID: '0', STAGE_ID: 'NEW', STAGE_SEMANTIC_ID: 'P',
    OPPORTUNITY: '100000', CURRENCY_ID: 'RUB',
    DATE_CREATE: created, DATE_MODIFY: now,
  };
  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/crm.deal.get.json'))
      return { ok: true, status: 200, json: async () => ({ result: deal }) };
    if (path.endsWith('/crm.status.list.json'))
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    if (path.endsWith('/crm.activity.get.json'))
      return { ok: true, status: 200, json: async () => ({
        result: { ID: '9919962', OWNER_TYPE_ID: '3', OWNER_ID: '22' },
      }) };
    throw new Error('Unexpected mock CRM call: ' + path);
  };

  const sales = require('./sales');
  let state = sales.status();
  assert.equal(state.lastProcessedEventAt, null);
  assert.equal(state.lastFailedEventAt, null);
  assert.equal(state.lastIgnoredEventAt, null);

  await sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: id }, { propagateError: true });
  state = sales.status();
  assert.ok(state.lastProcessedEventAt && Number.isFinite(Date.parse(state.lastProcessedEventAt)));
  assert.equal(state.lastFailedEventAt, null);
  assert.equal(state.lastIgnoredEventAt, null);
  const processedAt = state.lastProcessedEventAt;
  assert.equal(state.counts.tracked, 1);

  global.fetch = async () => { throw new Error('mock transport unavailable'); };
  await assert.rejects(
    sales.handleEvent({ event: 'ONCRMDEALUPDATE', dealId: '9919963' }, { propagateError: true })
  );
  state = sales.status();
  assert.ok(state.lastFailedEventAt && Number.isFinite(Date.parse(state.lastFailedEventAt)));
  assert.equal(state.lastProcessedEventAt, processedAt,
    'failure must not be disguised as successful CRM processing');

  global.fetch = async input => {
    const path = new URL(String(input)).pathname;
    assert.ok(path.endsWith('/crm.activity.get.json'), 'ignored activity must not read/write a deal');
    return { ok: true, status: 200, json: async () => ({
      result: { ID: '9919962', OWNER_TYPE_ID: '3', OWNER_ID: '22' },
    }) };
  };
  await sales.handleEvent({ event: 'ONCRMACTIVITYADD', activityId: '9919962' }, { propagateError: true });
  state = sales.status();
  assert.ok(state.lastIgnoredEventAt && Number.isFinite(Date.parse(state.lastIgnoredEventAt)));
  assert.equal(state.lastProcessedEventAt, processedAt);
  assert.ok(state.lastFailedEventAt, 'an ignored activity cannot erase the last failure audit');
  assert.equal(state.counts.tracked, 1);
});
