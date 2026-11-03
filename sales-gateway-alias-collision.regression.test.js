'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const token = 'collision-regression-token';

test('JSON webhook rejects conflicting identity, event and token aliases', () => {
  const original = {
    event: 'ONCRMDEALUPDATE',
    data: { FIELDS: { ID: 941002 } },
    auth: { application_token: token },
  };
  for (const extra of [
    { EVENT: 'ONCRMACTIVITYADD' },
    { EVENT: false },
    { data: { FIELDS: { ID: 941002 }, ID: 941003 } },
    { data: { FIELDS: { ID: 941002 } }, dealId: '941003' },
    { application_token: 'different-token' },
    { application_token: ['not-a-token'] },
  ]) {
    const raw = JSON.stringify({ ...original, ...extra });
    assert.equal(parseBitrixEvent(raw, 'application/json', token), null,
      'conflicting JSON aliases must not silently select the first: ' + raw);
  }
});

test('form webhook rejects conflicting aliases even when each key appears once', () => {
  const original = [
    ['event', 'ONCRMDEALUPDATE'],
    ['data[FIELDS][ID]', '941002'],
    ['auth[application_token]', token],
  ];
  for (const extra of [
    ['EVENT', 'ONCRMACTIVITYADD'],
    ['data[ID]', '941003'],
    ['dealId', '941003'],
    ['application_token', 'different-token'],
  ]) {
    const params = new URLSearchParams([...original, extra]);
    assert.equal(parseBitrixEvent(params.toString(), 'application/x-www-form-urlencoded', token), null,
      'distinct aliases with conflicting values are ambiguous: ' + extra[0]);
  }
});

test('matching aliases and genuine legacy fallbacks remain supported', () => {
  const aliases = new URLSearchParams([
    ['event', 'ONCRMDEALUPDATE'], ['EVENT', 'oncrmdealupdate'],
    ['data[FIELDS][ID]', '941002'], ['data[ID]', '941002'],
    ['auth[application_token]', token], ['application_token', token],
  ]);
  assert.deepEqual(parseBitrixEvent(aliases.toString(), 'application/x-www-form-urlencoded', token), {
    event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null,
  });
  const json = {
    event: 'ONCRMDEALUPDATE', EVENT: 'oncrmdealupdate',
    data: { FIELDS: { ID: 941002 }, ID: '941002' },
    auth: { application_token: token }, application_token: token,
  };
  assert.deepEqual(parseBitrixEvent(JSON.stringify(json), 'application/json', token), {
    event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null,
  });
  assert.deepEqual(parseBitrixEvent(JSON.stringify({
    EVENT: 'ONCRMDEALUPDATE', data: { ID: '941002' }, application_token: token,
  }), 'application/json', token), {
    event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null,
  });
});
