'use strict';

// Offline regression: an event must not carry an ID alias belonging to the
// opposite CRM entity, even when the canonical FIELDS.ID happens to match.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const token = 'sales-foreign-alias-test-only';
const cases = [
  { event: 'ONCRMDEALUPDATE', id: '941002', bad: 'activityId', good: 'dealId' },
  { event: 'ONCRMACTIVITYUPDATE', id: '941003', bad: 'dealId', good: 'activityId' },
];

test('JSON Bitrix webhook rejects a wrong-type ID alias alongside canonical identity', () => {
  for (const { event, id, bad, good } of cases) {
    const body = fields => JSON.stringify({
      event, data: { FIELDS: { ID: id } }, auth: { application_token: token }, ...fields,
    });
    assert.equal(parseBitrixEvent(body({ [bad]: id }), 'application/json', token), null,
      bad + ' is not a valid alias for ' + event);
    assert.ok(parseBitrixEvent(body({ [good]: id }), 'application/json', token),
      'the correctly typed alias remains compatible');
    assert.ok(parseBitrixEvent(body({}), 'application/json', token),
      'the canonical Bitrix FIELDS.ID remains compatible');
  }
});

test('form Bitrix webhook rejects a wrong-type ID alias alongside canonical identity', () => {
  for (const { event, id, bad, good } of cases) {
    const form = fields => new URLSearchParams([
      ['event', event], ['data[FIELDS][ID]', id],
      ['auth[application_token]', token], ...fields,
    ]).toString();
    assert.equal(parseBitrixEvent(form([[bad, id]]), 'application/x-www-form-urlencoded', token), null,
      bad + ' is not a valid alias for ' + event);
    assert.ok(parseBitrixEvent(form([[good, id]]), 'application/x-www-form-urlencoded', token),
      'the correctly typed alias remains compatible');
    assert.ok(parseBitrixEvent(form([]), 'application/x-www-form-urlencoded', token),
      'the canonical Bitrix FIELDS.ID remains compatible');
  }
});
