'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeDealNextActivity } = require('./sales-activity-readonly');

// All responses are in-memory mocks; no Bitrix URL or credential is used.
const secret = 'fake-bitrix-webhook-token-NEVER-LOG';
const credentialError = () => new Error('GET https://example.invalid/rest/user/' + secret + '/crm.activity.list.json');

function assertRedacted(error) {
  assert.equal(error.message, 'Bitrix activity read failed');
  assert.equal(error.cause, undefined, 'raw transport errors must not be chained');
  assert.equal(String(error.stack).includes(secret), false);
  return true;
}

test('read-only Next Step probe redacts injected transport failures', async () => {
  await assert.rejects(
    probeDealNextActivity(async () => { throw credentialError(); }, 72),
    assertRedacted,
  );
});

test('read-only Next Step probe redacts secret-bearing response getter failures', async () => {
  const topLevel = {};
  Object.defineProperty(topLevel, 'result', {
    enumerable: true,
    get() { throw credentialError(); },
  });
  await assert.rejects(
    probeDealNextActivity(async () => topLevel, 72),
    assertRedacted,
  );

  const activity = {
    ID: 101, OWNER_TYPE_ID: 2, OWNER_ID: 72, COMPLETED: 'N',
  };
  Object.defineProperty(activity, 'DEADLINE', {
    enumerable: true,
    get() { throw credentialError(); },
  });
  await assert.rejects(
    probeDealNextActivity(async () => ({ result: [activity], total: 1 }), 72),
    assertRedacted,
  );
});

test('incomplete cyclic response objects fail without leaking a transport exception', async () => {
  const response = { result: [] };
  response.result.push(response);
  await assert.rejects(
    probeDealNextActivity(async () => response, 72),
    assertRedacted,
  );
});

test('ordinary JSON activity responses still produce read-only Next Step', async () => {
  const result = await probeDealNextActivity(async (method, params) => {
    assert.equal(method, 'crm.activity.list');
    assert.equal(params.filter.COMPLETED, 'N');
    return {
      result: [{
        ID: 101, OWNER_TYPE_ID: 2, OWNER_ID: 72, COMPLETED: 'N',
        DEADLINE: '2026-11-07T09:30:00+03:00',
      }],
      total: 1,
    };
  }, 72);
  assert.deepEqual(result, {
    nextActivityAt: '2026-11-07T06:30:00.000Z',
    activitiesWithNoDeadline: 0,
    checked: 1,
  });
});
