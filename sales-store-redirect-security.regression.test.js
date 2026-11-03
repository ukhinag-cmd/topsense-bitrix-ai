'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Sales store never forwards its shared secret through unsafe redirects', async t => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const previousEnv = {
    BITRIX_WEBHOOK_BASE: process.env.BITRIX_WEBHOOK_BASE,
    GOOGLE_SHEET_STORE_URL: process.env.GOOGLE_SHEET_STORE_URL,
    GOOGLE_SHEET_STORE_SECRET: process.env.GOOGLE_SHEET_STORE_SECRET,
  };
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const storeUrl = 'https://script.google.com/macros/s/test-only/exec';
  const googleContentUrl = 'https://script.googleusercontent.com/macros/echo?test=1';
  const hostileUrl = 'https://hostile.example.test/steal';
  const secret = 'test-only-store-secret';
  process.env.BITRIX_WEBHOOK_BASE = 'https://bitrix.example.test/rest/test/';
  process.env.GOOGLE_SHEET_STORE_URL = storeUrl;
  process.env.GOOGLE_SHEET_STORE_SECRET = secret;

  global.setTimeout = (fn, ms, ...args) =>
    (ms === 5000 || ms === 2500) ? { unref() {} } : originalSetTimeout(fn, ms, ...args);
  global.setInterval = (fn, ms, ...args) =>
    ms === 120000 ? { unref() {} } : originalSetInterval(fn, ms, ...args);

  let mode = 'google-302';
  let redirectGetCount = 0;
  let leakedSecret = false;
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/crm.status.list.json')) {
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (url === storeUrl) {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).secret, secret);
      if (mode === 'google-302') {
        return {
          ok: false, status: 302,
          headers: { get: key => key.toLowerCase() === 'location' ? googleContentUrl : null },
          text: async () => '',
        };
      }
      if (options.redirect === 'follow') {
        // Model Fetch's default 307 behavior: the POST body is forwarded
        // unchanged to another host before the caller sees the response.
        leakedSecret = JSON.parse(options.body).secret === secret;
        return { ok: true, status: 200, text: async () => '{"rows":[]}' };
      }
      return {
        ok: false, status: 307,
        headers: { get: key => key.toLowerCase() === 'location' ? hostileUrl : null },
        text: async () => '',
      };
    }
    if (url === googleContentUrl) {
      redirectGetCount += 1;
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined, 'the redirected GET must not carry the store secret');
      assert.equal(options.headers?.['content-type'], undefined);
      return { ok: true, status: 200, text: async () => '{"rows":[]}' };
    }
    if (url === hostileUrl) {
      leakedSecret = Boolean(options.body && String(options.body).includes(secret));
      return { ok: true, status: 200, text: async () => '{"rows":[]}' };
    }
    throw new Error('Unexpected mocked request: ' + url);
  };

  const sales = require('./sales');
  await sales.start();
  assert.equal(redirectGetCount, 1, 'a normal Google Apps Script 302 must resolve via a credential-free GET');
  assert.equal(sales.status().lastError, null);

  mode = 'untrusted-307';
  await sales.start();
  assert.equal(leakedSecret, false, '307 redirects must never forward the shared store secret');
  assert.equal(redirectGetCount, 1, 'the unsafe redirect must not be followed');
  assert.equal(sales.status().lastError?.source, 'sales-store-load',
    'an unsafe redirect is a visible store read failure');
});
