import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {safeUrl, extractHints, run} from './top-sens-site-probe.mjs';

test('safe URL rejects local/private hostnames and credentials', () => {
 assert.equal(safeUrl('http://localhost/admin'), null);
 assert.equal(safeUrl('http://127.0.0.1/'), null);
 assert.equal(safeUrl('https://u:p@example.com'), null);
 assert.ok(safeUrl('https://example.com/contacts/'));
});
test('hints retain evidence but never assert verified address', () => {
 const h=extractHints('<div>ООО «Ромашка» ИНН 7701234567</div><p>г. Москва, ул. Лесная, д. 4</p><p>info@example.ru +7 (495) 123-45-67</p>');
 assert.deepEqual(h.inns, ['7701234567']);
 assert.ok(h.emails.includes('info@example.ru'));
 assert.ok(h.address_hints.some(x=>x.includes('Лесная')));
});
test('run validates IDs and marks rows without URL as unverified', async () => {
 await assert.rejects(run([{id:1},{id:1}]), /Duplicate IDs/);
 const r=await run([{id:121,company:'ООО Пример'}]);
 assert.equal(r[0].status,'NO_SAFE_URL');
 assert.deepEqual(r[0].verified_fields,[]);
});