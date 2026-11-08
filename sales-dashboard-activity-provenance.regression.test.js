'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sales = require('./sales');

// crm.deal.get LAST_ACTIVITY_TIME is the latest CRM timeline activity, which
// is not necessarily a customer conversation. Do not present it as a verified
// "last contact" in the read-only dashboard or understate this distinction.
test('Sales Dashboard labels Bitrix timeline activity without claiming customer contact', () => {
  const html = sales.html();
  assert.match(html, /<th>Последняя активность CRM<\/th>/);
  assert.doesNotMatch(html, /<th>Последний контакт<\/th>/);
  // Risk scoring uses the same timeline proxy, not a validated outbound or
  // inbound customer communication. Operators must see the limitation.
  assert.match(html, /Risk Score оценивает давность по последней активности в CRM-таймлайне/);
  assert.match(html, /LAST_ACTIVITY_TIME/);
  assert.match(html, /проверьте звонки и переписку в Bitrix24/);
});
