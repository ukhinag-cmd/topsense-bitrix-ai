'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_EVENT_BODY,
  decodeBasicCredentials,
  parseBitrixEvent,
  sanitizeProxyHeaders,
} = require('./sales-gateway-helpers');

const token = 'test-app-token-123';
const basic = value => 'Basic ' + Buffer.from(value).toString('base64');

test('parses a valid form-encoded deal update without returning its token', () => {
  const raw = 'event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=38742&auth%5Bapplication_token%5D=' + encodeURIComponent(token);
  assert.deepEqual(parseBitrixEvent(raw, 'application/x-www-form-urlencoded', token), {
    event: 'ONCRMDEALUPDATE', dealId: '38742', activityId: null,
  });
});

test('parses a valid JSON deal-add event', () => {
  const raw = JSON.stringify({ event: 'ONCRMDEALADD', data: { FIELDS: { ID: 40880 } }, auth: { application_token: token } });
  assert.equal(parseBitrixEvent(raw, 'application/json', token).dealId, '40880');
});

test('parses a valid activity-add event with owner metadata', () => {
  const raw = 'event=ONCRMACTIVITYADD&data%5BFIELDS%5D%5BID%5D=336552&data%5BFIELDS%5D%5BOWNER_TYPE_ID%5D=2&auth%5Bapplication_token%5D=' + token;
  assert.deepEqual(parseBitrixEvent(raw, 'application/x-www-form-urlencoded', token), {
    event: 'ONCRMACTIVITYADD', dealId: null, activityId: '336552',
    activityProviderId: null, activityDirection: null, activityOwnerTypeId: '2',
  });
});

test('fails closed if the expected token is absent', () => {
  const raw = 'event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=1&auth%5Bapplication_token%5D=' + token;
  assert.equal(parseBitrixEvent(raw, 'application/x-www-form-urlencoded', ''), null);
});

test('rejects a mismatched application token', () => {
  const raw = 'event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=1&auth%5Bapplication_token%5D=wrong';
  assert.equal(parseBitrixEvent(raw, 'application/x-www-form-urlencoded', token), null);
});

test('rejects unsupported events and deletion events', () => {
  assert.equal(parseBitrixEvent(JSON.stringify({event:'ONCRMDEALDELETE',data:{ID:1},auth:{application_token:token}}), 'application/json', token), null);
  assert.equal(parseBitrixEvent(JSON.stringify({event:'ONCRMCONTACTUPDATE',data:{ID:1},auth:{application_token:token}}), 'application/json', token), null);
});

test('rejects missing, malformed, zero and unsafe IDs', () => {
  for (const id of [undefined, 'abc', 0, -1, '9007199254740992']) {
    const raw = JSON.stringify({event:'ONCRMDEALUPDATE',data:{FIELDS:{ID:id}},auth:{application_token:token}});
    assert.equal(parseBitrixEvent(raw, 'application/json', token), null);
  }
});

test('rejects malformed JSON and oversized event bodies', () => {
  assert.equal(parseBitrixEvent('{broken', 'application/json', token), null);
  assert.equal(parseBitrixEvent(Buffer.alloc(MAX_EVENT_BODY + 1, 65), 'text/plain', token), null);
});

test('strictly decodes valid Basic credentials and rejects malformed base64', () => {
  assert.deepEqual(decodeBasicCredentials(basic('sales:secret')), { username: 'sales', password: 'secret' });
  assert.equal(decodeBasicCredentials('Basic c2FsZXM6c2VjcmV0!!!'), null);
  assert.equal(decodeBasicCredentials('Basic c2FsZXM6==='), null);
});

test('always strips Proxy-Authorization and removes Sales or malformed Basic credentials', () => {
  const headers = sanitizeProxyHeaders({
    'proxy-authorization': basic('proxy:secret'),
    authorization: basic('sales:dashboard-secret'),
    'x-request-id': 'test-1',
  }, 'dashboard-secret');
  assert.equal('proxy-authorization' in headers, false);
  assert.equal('authorization' in headers, false);
  assert.equal(headers['x-request-id'], 'test-1');
  assert.equal('authorization' in sanitizeProxyHeaders({ authorization: 'Basic c2FsZXM6c2VjcmV0!!!' }, 'secret'), false);
});

test('preserves valid unrelated Basic and non-Basic authorization', () => {
  assert.equal(sanitizeProxyHeaders({ authorization: basic('upstream:password') }, 'dashboard-secret').authorization, basic('upstream:password'));
  assert.equal(sanitizeProxyHeaders({ authorization: 'Bearer abc' }, 'dashboard-secret').authorization, 'Bearer abc');
});
