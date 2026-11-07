'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('malformed user.get display fields cannot poison a verified Sales manager label', async () => {
  const responses = [
    [{ ID: '7', NAME: ['Impostor'], LAST_NAME: 'Manager' }],
    [{ ID: '7', NAME: 'Verified', LAST_NAME: 'Manager' }],
    [{ ID: '8', NAME: '', LAST_NAME: ['False surname'] }],
    [{ ID: '8', NAME: '', LAST_NAME: '', EMAIL: ['fake@example.test'] }],
    [{ ID: '8', NAME: '', LAST_NAME: '', EMAIL: 'verified@example.test' }],
    [{ ID: '9', NAME: 'Stale', LAST_NAME: 'Manager' }, { ID: 9, NAME: 'Conflicting', LAST_NAME: 'Manager' }],
    [{ ID: 9, NAME: 'Recovered', LAST_NAME: 'Manager' }],
  ];
  const requestedIds = [];
  const context = {
    module: { exports: {} },
    process: { env: { BITRIX_WEBHOOK_BASE: 'https://bitrix.example.test/rest/1/test/' } },
    URL, AbortSignal, console,
    fetch: async (input, options = {}) => {
      assert.ok(String(input).endsWith('/user.get.json'));
      requestedIds.push(JSON.parse(options.body).ID);
      return { ok: true, status: 200, json: async () => ({ result: responses.shift() }) };
    },
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__testManagerName = managerName;',
    context, { filename: 'sales.js' });
  const managerName = context.module.exports.__testManagerName;

  assert.equal(await managerName('7'), '#7',
    'an array masquerading as a given name must not become a trusted manager');
  assert.equal(await managerName('7'), 'Verified Manager',
    'a subsequent valid identity must still be queried and accepted');
  assert.equal(await managerName('7'), 'Verified Manager',
    'a verified scalar identity can be cached without further requests');

  assert.equal(await managerName('8'), '#8',
    'an array masquerading as a surname must not be displayed');
  assert.equal(await managerName('8'), '#8',
    'an array masquerading as an email must not be displayed');
  assert.equal(await managerName('8'), 'verified@example.test',
    'a valid email fallback must still work after malformed user responses');
  assert.equal(await managerName('8'), 'verified@example.test');
  assert.equal(await managerName('9'), '#9',
    'duplicate matching user.get identities must not certify a possibly stale manager label');
  assert.equal(await managerName('9'), 'Recovered Manager',
    'a later unique verified user response must remain retryable');
  assert.equal(await managerName('9'), 'Recovered Manager',
    'a recovered unique manager identity can be cached');

  assert.deepEqual(requestedIds, [7, 7, 8, 8, 8, 9, 9],
    'malformed user responses must remain retryable and never poison the cache');
});
