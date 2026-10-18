"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const proof=require("./sender-domain-site-proof");
test("original corporate email host matches website host without INN or CRM card",()=>{
 assert.equal(proof.matches("factory.ru","https://factory.ru"),true);
 assert.equal(proof.matches("factory.ru","https://www.factory.ru/about"),true);
 assert.equal(proof.matches("factory.ru","https://another-factory.ru"),false);
 assert.equal(proof.matches("factory.ru","https://factory.ru.example.com"),false);
});
test("public mail, TOP-SENSE sender and redirects to other domains are not identity proof",()=>{
 for(const domain of ["gmail.com","mail.ru","yandex.ru","rutector.email","topsense.su"])
  assert.equal(proof.matches(domain,"https://"+domain),false);
 assert.equal(proof.matches("factory.ru","https://other.ru"),false);
});
