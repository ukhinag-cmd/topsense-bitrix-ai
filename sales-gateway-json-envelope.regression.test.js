'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const token = 'test-bitrix-envelope-token';
const contentType = 'application/json';
const base = {
  event: 'ONCRMDEALUPDATE',
  data: { FIELDS: { ID: 941002 } },
  auth: { application_token: token },
};

test('malformed JSON Bitrix container fields cannot be masked by valid fallback aliases', () => {
  const cases = [
    { data: [], dealId: '941002' },
    { data: 'invalid', dealId: '941002' },
    { data: true, dealId: '941002' },
    { data: { FIELDS: [], ID: '941002' } },
    { data: { FIELDS: 'invalid', ID: '941002' } },
    { data: { FIELDS: true, ID: '941002' } },
    { auth: [], application_token: token },
    { auth: 'invalid', application_token: token },
    { auth: true, application_token: token },
  ];
  for (const changes of cases) {
    const raw = JSON.stringify({ ...base, ...changes });
    assert.equal(parseBitrixEvent(raw, contentType, token), null,
      'malformed primary JSON object must not fall back to an alternate identity or token: ' + raw);
  }
});

test('missing or null JSON containers retain valid legacy scalar fallbacks', () => {
  for (const raw of [
    { event: 'ONCRMDEALUPDATE', dealId: 941002, application_token: token },
    { event: 'ONCRMDEALUPDATE', data: null, dealId: 941002, auth: null, application_token: token },
    { event: 'ONCRMDEALUPDATE', data: { FIELDS: null, ID: 941002 }, auth: { application_token: token } },
  ]) {
    assert.deepEqual(parseBitrixEvent(JSON.stringify(raw), contentType, token), {
      event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null,
    });
  }
});
