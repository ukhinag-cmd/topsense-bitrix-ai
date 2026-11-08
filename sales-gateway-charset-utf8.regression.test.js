'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

// Mock-only parser checks. No HTTP listener or live Bitrix requests.
const token = 'mock-utf8-bitrix-token';
const event = {
  event: 'ONCRMDEALUPDATE',
  data: { FIELDS: { ID: '941002' } },
  auth: { application_token: token },
};
const json = JSON.stringify(event);
const expected = { event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null };

test('authenticated webhook rejects contradictory or unsupported charset declarations', () => {
  for (const contentType of [
    'application/json; charset=iso-8859-1',
    'application/json; charset=utf-16le',
    'application/json; charset=utf-8; charset=latin1',
    'application/json; charset=',
    'application/x-www-form-urlencoded; charset=windows-1251',
  ]) {
    const body = contentType.startsWith('application/json')
      ? json : new URLSearchParams({
        event: 'ONCRMDEALUPDATE',
        'data[FIELDS][ID]': '941002',
        'auth[application_token]': token,
      }).toString();
    assert.equal(parseBitrixEvent(body, contentType, token), null,
      'mismatched HTTP charset must not certify a Bitrix event: ' + contentType);
  }
});

test('ordinary UTF-8 charset declarations and absent charset are supported', () => {
  for (const contentType of [
    'application/json',
    'application/json; charset=utf-8',
    'application/json; CHARSET="UTF-8"',
    'application/json; charset=UTF-8; profile=bitrix',
  ]) {
    assert.deepEqual(parseBitrixEvent(json, contentType, token), expected);
  }
});

test('authenticated webhook rejects malformed UTF-8 input even if identity and token decode', () => {
  // Decoding Buffer as a string silently replaces the invalid 0xff byte
  // with U+FFFD in an unrelated JSON field. Different intermediaries may
  // interpret the original payload differently.
  const left = Buffer.from(json.slice(0, -1) + ',"unused":"', 'utf8');
  const right = Buffer.from('"}', 'utf8');
  const invalid = Buffer.concat([left, Buffer.from([0xff]), right]);
  assert.equal(parseBitrixEvent(invalid, 'application/json; charset=utf-8', token), null);
  assert.deepEqual(parseBitrixEvent(Buffer.from(json, 'utf8'), 'application/json', token), expected);
});
