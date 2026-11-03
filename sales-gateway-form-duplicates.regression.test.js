'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const token = 'duplicate-form-identity-token';

const primary = () => new URLSearchParams([
  ['event', 'ONCRMDEALUPDATE'],
  ['data[FIELDS][ID]', '941002'],
  ['auth[application_token]', token],
]);

test('Bitrix form webhook rejects repeated event, entity and token keys', () => {
  const extra = new Map([
    ['event', 'ONCRMDEALADD'],
    ['data[FIELDS][ID]', '941003'],
    ['auth[application_token]', 'wrong-token'],
  ]);
  for (const [key, second] of extra) {
    const form = primary();
    form.append(key, second);
    assert.equal(parseBitrixEvent(form.toString(), 'application/x-www-form-urlencoded', token), null,
      'duplicate canonical form key must not select the first value: ' + key);
  }
});

test('Bitrix form webhook rejects repeated fallback keys and optional activity metadata', () => {
  const fallback = new URLSearchParams([
    ['EVENT', 'ONCRMACTIVITYUPDATE'],
    ['data[ID]', '941002'],
    ['application_token', token],
    ['data[FIELDS][OWNER_TYPE_ID]', '2'],
  ]);
  const alternatives = new Map([
    ['EVENT', 'ONCRMDEALUPDATE'],
    ['data[ID]', '941003'],
    ['application_token', 'wrong-token'],
    ['data[FIELDS][OWNER_TYPE_ID]', '3'],
  ]);
  for (const [key, second] of alternatives) {
    const form = new URLSearchParams(fallback);
    form.append(key, second);
    assert.equal(parseBitrixEvent(form.toString(), 'application/x-www-form-urlencoded', token), null,
      'duplicate fallback/metadata form key is ambiguous: ' + key);
  }
});

test('unique event identity and authentication still accept repeated unrelated form fields', () => {
  const form = primary();
  form.append('custom[]', 'a');
  form.append('custom[]', 'b');
  assert.deepEqual(parseBitrixEvent(form.toString(), 'application/x-www-form-urlencoded', token), {
    event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null,
  });
});
