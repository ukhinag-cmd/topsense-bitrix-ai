'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const token = 'json-duplicate-keys-regression-token';
const event = 'ONCRMDEALUPDATE';
const canonical = `{"event":"${event}","data":{"FIELDS":{"ID":941002}},"auth":{"application_token":"${token}"}}`;
const expected = { event, dealId: '941002', activityId: null };

test('JSON webhook rejects duplicate object keys before parser precedence can hide an identity or credential', () => {
  // JSON.parse silently keeps the final property. A different gateway or
  // verifier may use the first one, so even identical duplicate names are
  // ambiguous. This is the JSON counterpart to rejecting repeated form keys.
  const ambiguous = [
    `{"event":"ONCRMACTIVITYADD","event":"${event}","data":{"FIELDS":{"ID":941002}},"auth":{"application_token":"${token}"}}`,
    `{"event":"${event}","data":{"FIELDS":{"ID":941003,"ID":941002}},"auth":{"application_token":"${token}"}}`,
    `{"event":"${event}","data":{"FIELDS":{"ID":941002}},"auth":{"application_token":"incorrect","application_token":"${token}"}}`,
    `{"event":"${event}","data":{"FIELDS":{"ID":941002}},"auth":{"application_token":"${token}","application_token":"${token}"}}`,
    `{"event":"ONCRMACTIVITYADD","\\u0065vent":"${event}","data":{"FIELDS":{"ID":941002}},"auth":{"application_token":"${token}"}}`,
  ];
  for (const raw of ambiguous) {
    assert.equal(parseBitrixEvent(raw, 'application/json', token), null,
      'duplicate JSON property names must fail closed: ' + raw);
  }
});

test('JSON duplicate-key defense preserves legitimate repeated names in separate objects and quoted text', () => {
  assert.deepEqual(parseBitrixEvent(canonical, 'application/json', token), expected);
  const withMetadata = `{"meta":[{"note":"event and ID \\"auth\\": repeated text","kind":"a"},{"note":"other","kind":"b"}],"event":"${event}","data":{"FIELDS":{"ID":941002}},"auth":{"application_token":"${token}"}}`;
  assert.deepEqual(parseBitrixEvent(withMetadata, 'application/json', token), expected);
  // An escaped key has the same decoded name as the unescaped spelling.
  const singleEscaped = `{"\\u0065vent":"${event}","data":{"FIELDS":{"ID":941002}},"auth":{"application_token":"${token}"}}`;
  assert.deepEqual(parseBitrixEvent(singleEscaped, 'application/json', token), expected);
});
