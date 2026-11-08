'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const token = 'test-only-media-type-token';
const json = JSON.stringify({
  event: 'ONCRMDEALUPDATE',
  data: { FIELDS: { ID: '941002' } },
  auth: { application_token: token },
});
const form = new URLSearchParams({
  event: 'ONCRMDEALUPDATE',
  'data[FIELDS][ID]': '941002',
  'auth[application_token]': token,
}).toString();

test('authenticated webhook rejects unknown and misleading HTTP media types', () => {
  const invalid = [
    [json, 'application/json-corrupt'],
    [json, 'text/plain; note=application/json'],
    [json, 'application/json, application/x-www-form-urlencoded'],
    [form, 'text/plain'],
    [form, 'application/x-www-form-urlencoded-corrupt'],
    [form, ''],
  ];
  for (const [body, contentType] of invalid) {
    assert.equal(parseBitrixEvent(body, contentType, token), null,
      'unsupported HTTP Content-Type must never be interpreted as a trusted Bitrix event: ' + contentType);
  }
});

test('declared JSON and form media types keep supporting normal charset parameters', () => {
  const expected = { event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null };
  for (const contentType of ['application/json', 'application/json; charset=utf-8',
    'Application/JSON; charset=UTF-8']) {
    assert.deepEqual(parseBitrixEvent(json, contentType, token), expected);
  }
  for (const contentType of ['application/x-www-form-urlencoded',
    'application/x-www-form-urlencoded; charset=UTF-8']) {
    assert.deepEqual(parseBitrixEvent(form, contentType, token), expected);
  }
});
