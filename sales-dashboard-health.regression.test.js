'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sales = require('./sales');

test('Sales Dashboard does not claim live Bitrix data before the first successful sync', () => {
  const html = sales.html();
  assert.match(html, /Ожидание первой синхронизации/);
  assert.match(html, /class="live pending"/);
  assert.doesNotMatch(html, /данные Bitrix · автообновление 20 сек/);
});
