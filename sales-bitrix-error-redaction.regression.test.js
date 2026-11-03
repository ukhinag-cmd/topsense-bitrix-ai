'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

test('remote Bitrix REST errors cannot echo a webhook credential into Sales diagnostics', async () => {
  const secret = 'test-only-bitrix-path-credential-87943';
  const env = { BITRIX_WEBHOOK_BASE: 'https://bitrix.example.test/rest/1/' + secret + '/' };
  let payload = {
    error: 'INVALID_CREDENTIALS',
    error_description: 'Failed to access ' + env.BITRIX_WEBHOOK_BASE,
  };
  const context = {
    module: { exports: {} }, process: { env }, URL, AbortSignal, console,
    fetch: async () => ({ ok: false, status: 401, json: async () => payload }),
  };
  const source = fs.readFileSync(require.resolve('./sales'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.__readForTest = bitrixRaw;',
    context, { filename: 'sales.js' });
  const read = context.module.exports.__readForTest;

  await assert.rejects(read('crm.deal.get', { ID: 1 }), error => {
    assert.equal(error.message.includes(secret), false,
      'untrusted error_description must never include a credential in the diagnostic');
    assert.match(error.message, /Bitrix|HTTP/i);
    return true;
  });

  payload = { error: 'CUSTOM_' + secret, error_description: 'arbitrary provider text' };
  await assert.rejects(read('crm.deal.get', { ID: 1 }), error => {
    assert.equal(error.message.includes(secret), false,
      'untrusted error code must not be copied to logs or Dashboard health');
    return true;
  });
});

test('failed webhook audit never logs raw exception text containing credentials', async t => {
  const secret = 'test-only-secret-exception-65431';
  const previousLog = console.log;
  const previousWarn = console.warn;
  const records = [];
  console.log = (...args) => { records.push(args.map(String).join(' ')); };
  console.warn = (...args) => { records.push(args.map(String).join(' ')); };
  t.after(() => {
    console.log = previousLog;
    console.warn = previousWarn;
  });

  const gateway = createGateway({
    bitrixToken: 'test-only-application-token',
    dashboardToken: 'test-only-dashboard-token',
    salesModule: {
      html: () => '<h1>mock</h1>',
      status: () => ({ ok: true }),
      handleEvent: async () => {
        throw new Error('Request to https://bitrix.example.test/rest/1/' + secret + '/ failed');
      },
    },
  });
  const port = await new Promise(resolve =>
    gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port))
  );
  t.after(() => new Promise(resolve => gateway.close(resolve)));

  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/bitrix/events', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({
      event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: '55143' } },
      auth: { application_token: 'test-only-application-token' },
    }));
  });
  assert.equal(response, 200);
  for (let i = 0; i < 50 && !records.some(line =>
    line.includes('event-processing-failed')); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(records.some(line => line.includes('event-processing-failed')),
    'failed processing must remain observable');
  assert.equal(records.join('\n').includes(secret), false,
    'never log raw transport exception messages that may contain a webhook secret');
});
