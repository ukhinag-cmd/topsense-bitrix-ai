'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBitrixEvent } = require('./sales-gateway-helpers');

const applicationToken = 'sales-json-scalar-test-token';

function asEvent(changes = {}) {
  return JSON.stringify({
    event: 'ONCRMDEALUPDATE',
    data: { FIELDS: { ID: 941002 } },
    auth: { application_token: applicationToken },
    ...changes,
  });
}

test('authenticated Bitrix JSON event identity must be a scalar ID', () => {
  for (const id of [['941002'], [941002], { value: '941002' }, true]) {
    const raw = asEvent({ data: { FIELDS: { ID: id } } });
    assert.equal(parseBitrixEvent(raw, 'application/json', applicationToken), null,
      'malformed JSON ID must not be coerced into a valid CRM identifier');
  }
});

test('Bitrix JSON event name and application token must be strings', () => {
  for (const event of [['ONCRMDEALUPDATE'], { event: 'ONCRMDEALUPDATE' }]) {
    assert.equal(parseBitrixEvent(asEvent({ event }), 'application/json', applicationToken), null,
      'malformed JSON event type must not be accepted through String coercion');
  }
  for (const suppliedToken of [[applicationToken], { token: applicationToken }]) {
    const raw = asEvent({ auth: { application_token: suppliedToken } });
    assert.equal(parseBitrixEvent(raw, 'application/json', applicationToken), null,
      'malformed JSON token type must not pass authentication through String coercion');
  }
});

test('legitimate scalar JSON deal and activity IDs still work', () => {
  assert.deepEqual(parseBitrixEvent(asEvent(), 'application/json', applicationToken), {
    event: 'ONCRMDEALUPDATE', dealId: '941002', activityId: null,
  });
  assert.deepEqual(parseBitrixEvent(asEvent({
    event: 'ONCRMACTIVITYADD',
    data: { FIELDS: { ID: '941003', OWNER_TYPE_ID: '2' } },
  }), 'application/json', applicationToken), {
    event: 'ONCRMACTIVITYADD', dealId: null, activityId: '941003',
    activityProviderId: null, activityDirection: null, activityOwnerTypeId: '2',
  });
});
