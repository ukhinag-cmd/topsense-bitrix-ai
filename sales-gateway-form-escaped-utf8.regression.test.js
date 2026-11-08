'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

// Mock-only form parsing; no HTTP server, Bitrix24, Render or Sheets access.
const token = 'form-percent-utf8-mock-token';
const base = new URLSearchParams({
  event: 'ONCRMDEALUPDATE',
  'data[FIELDS][ID]': '941002',
  'auth[application_token]': token,
}).toString();
const expected = { event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null };

test('authenticated form webhook rejects invalid UTF-8 hidden inside percent escapes', () => {
  // The wire body consists entirely of valid ASCII bytes. URLSearchParams
  // silently replaces these *decoded* invalid UTF-8 octets with U+FFFD.
  // Valid event and credentials must not mask ambiguous unrelated metadata.
  for (const escaped of ['%FF', '%C3%28', '%ED%A0%80', '%E0%A4%A']) {
    assert.equal(
      parseBitrixEvent(base + '&vendorNote=' + escaped, 'application/x-www-form-urlencoded; charset=utf-8', token),
      null,
      'ambiguous percent-encoded UTF-8 was accepted: ' + escaped
    );
  }
});

test('authenticated form webhook retains valid escaped UTF-8 and literal percent signs', () => {
  for (const extra of ['vendorNote=%D0%A2%D0%B5%D1%81%D1%82', 'vendorNote=100%25+ok']) {
    assert.deepEqual(
      parseBitrixEvent(base + '&' + extra, 'application/x-www-form-urlencoded', token),
      expected
    );
  }
});
