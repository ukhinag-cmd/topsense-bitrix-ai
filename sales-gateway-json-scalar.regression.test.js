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

// Optional activity metadata is untrusted JSON too. An array can masquerade
// as a scalar and an object with its own non-callable toString can make
// String(value) throw, potentially crashing the HTTP webhook handler.
test('malformed optional JSON activity metadata is rejected without coercion or exceptions', () => {
  for (const field of ['PROVIDER_ID', 'DIRECTION', 'OWNER_TYPE_ID']) {
    for (const value of [['2'], { toString: null }, true]) {
      const raw = asEvent({
        event: 'ONCRMACTIVITYUPDATE',
        data: { FIELDS: { ID: '941003', [field]: value } },
      });
      assert.doesNotThrow(() => parseBitrixEvent(raw, 'application/json', applicationToken),
        field + ' must not throw for an untrusted JSON object');
      assert.equal(parseBitrixEvent(raw, 'application/json', applicationToken), null,
        field + ' must not accept a non-scalar optional value');
    }
  }
});

test('legitimate numeric JSON activity metadata remains supported', () => {
  assert.deepEqual(parseBitrixEvent(asEvent({
    event: 'ONCRMACTIVITYUPDATE',
    data: { FIELDS: { ID: 941003, PROVIDER_ID: 'CRM', DIRECTION: 2, OWNER_TYPE_ID: 2 } },
  }), 'application/json', applicationToken), {
    event: 'ONCRMACTIVITYUPDATE', dealId: null, activityId: '941003',
    activityProviderId: 'CRM', activityDirection: '2', activityOwnerTypeId: '2',
  });
});

test('explicit false-valued JSON metadata is rejected; numeric zero is retained', () => {
  // Explicit false is not the same as an absent optional field. A truthy
  // fallback (|| null) silently drops it before the scalar validator runs.
  for (const field of ['PROVIDER_ID', 'DIRECTION', 'OWNER_TYPE_ID']) {
    const raw = asEvent({
      event: 'ONCRMACTIVITYUPDATE',
      data: { FIELDS: { ID: '941003', [field]: false } },
    });
    assert.equal(parseBitrixEvent(raw, 'application/json', applicationToken), null,
      field + ' must reject explicit boolean false instead of erasing it');
  }

  const zero = asEvent({
    event: 'ONCRMACTIVITYUPDATE',
    data: { FIELDS: { ID: '941003', DIRECTION: 0, OWNER_TYPE_ID: 0 } },
  });
  assert.deepEqual(parseBitrixEvent(zero, 'application/json', applicationToken), {
    event: 'ONCRMACTIVITYUPDATE', dealId: null, activityId: '941003',
    activityProviderId: null, activityDirection: '0', activityOwnerTypeId: '0',
  }, 'finite numeric metadata must not disappear due to truthiness');
});
