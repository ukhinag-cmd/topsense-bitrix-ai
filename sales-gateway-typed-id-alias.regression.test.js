'use strict';

// Offline: an authenticated but structurally mismatched webhook must never
// resolve an activity identifier as a deal identifier (or vice versa).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const token = 'typed-identity-only-test-token';
const parseJson = payload => parseBitrixEvent(
  JSON.stringify({ ...payload, auth: { application_token: token } }),
  'application/json',
  token
);
const parseForm = fields => parseBitrixEvent(
  new URLSearchParams([...fields, ['auth[application_token]', token]]).toString(),
  'application/x-www-form-urlencoded',
  token
);

test('JSON Bitrix event accepts only fallback ID matching the event entity type', () => {
  assert.equal(parseJson({ event: 'ONCRMDEALUPDATE', activityId: '941003' }), null,
    'an activityId alone is not a deal identifier');
  assert.equal(parseJson({ event: 'ONCRMACTIVITYUPDATE', dealId: '941002' }), null,
    'a dealId alone is not an activity identifier');

  assert.deepEqual(parseJson({ event: 'ONCRMDEALUPDATE', dealId: '941002' }), {
    event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null,
  });
  assert.deepEqual(parseJson({ event: 'ONCRMACTIVITYUPDATE', activityId: '941003' }), {
    event: 'ONCRMACTIVITYUPDATE', dealId: null, activityId: '941003',
    activityProviderId: null, activityDirection: null, activityOwnerTypeId: null,
  });
});

test('form Bitrix event accepts only fallback ID matching the event entity type', () => {
  assert.equal(parseForm([['event', 'ONCRMDEALADD'], ['activityId', '941003']]), null);
  assert.equal(parseForm([['event', 'ONCRMACTIVITYADD'], ['dealId', '941002']]), null);

  assert.deepEqual(parseForm([['event', 'ONCRMDEALADD'], ['dealId', '941002']]), {
    event: 'ONCRMDEALADD', dealId: '941002', activityId: null,
  });
  assert.deepEqual(parseForm([['event', 'ONCRMACTIVITYADD'], ['activityId', '941003']]), {
    event: 'ONCRMACTIVITYADD', dealId: null, activityId: '941003',
    activityProviderId: null, activityDirection: null, activityOwnerTypeId: null,
  });

  // Genuine Bitrix webhook identities live under data[FIELDS][ID] for both event types.
  assert.equal(parseForm([['event', 'ONCRMACTIVITYADD'],
    ['data[FIELDS][ID]', '941003']]).activityId, '941003');
});
