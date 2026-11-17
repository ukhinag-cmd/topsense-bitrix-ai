'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareBatch,normalizeInn,domain}=require('./okp-import-plan');

test('normalizes INN and official domain',()=>{
 assert.equal(normalizeInn('77 01 234567'),'7701234567');
 assert.equal(normalizeInn('bad'),'');
 assert.equal(domain('https://www.factory.ru/about/'),'factory.ru');
 assert.equal(domain('http://127.0.0.1/admin'),'');
});
test('requires verified identity and avoids duplicate company creation',()=>{
 const report=prepareBatch([
  {'Название компании':'Завод 1','ИНН':'7701234567','Адрес офиса':'Москва, Промышленная, 1'},
  {'Название компании':'Завод 1 (дубль)','ИНН':'7701234567'},
  {'Название компании':'Без реквизитов','Сайт':''}
 ],{existingCompanies:[{id:87,inn:'7701234567',website:'factory.ru'}]});
 assert.equal(report.mode,'dry_run');
 assert.equal(report.counts.updateCompany,1);
 assert.equal(report.counts.duplicates,1);
 assert.equal(report.counts.review,1);
 assert.equal(report.items[0].targetCompanyId,'87');
 assert.equal(report.items[0].dealAction,'check_existing_okp_deal_before_create');
});
test('separate organizations at one office are not duplicates',()=>{
 const result=prepareBatch([
  {'Компания':'А','ИНН':'7701234567','Фактический адрес':'Москва, ул. А, 1'},
  {'Компания':'Б','ИНН':'7701234568','Фактический адрес':'Москва, ул. А, 1'}
 ]);
 assert.equal(result.counts.createCompany,2);
});
test('ambiguous existing matches require human review',()=>{
 const result=prepareBatch([{'Компания':'Завод','ИНН':'7701234567'}],{
  existingCompanies:[{id:1,inn:'7701234567'},{id:2,inn:'7701234567'}]
 });
 assert.equal(result.items[0].action,'ambiguous_existing_company');
 assert.equal(result.items[0].dealAction,'not_allowed');
});
