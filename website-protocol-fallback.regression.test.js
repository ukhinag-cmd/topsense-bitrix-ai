"use strict";
const assert=require("node:assert/strict");
const {homepageVariants}=require("./website-profiler");

assert.deepEqual(homepageVariants("https://example.ru/"),
 ["https://example.ru/","http://example.ru/"]);
assert.deepEqual(homepageVariants("http://example.ru/"),
 ["http://example.ru/"]);
assert.deepEqual(homepageVariants("https://example.ru:8443/"),
 ["https://example.ru:8443/"]);
assert.deepEqual(homepageVariants("https://example.ru/about"),
 ["https://example.ru/about","http://example.ru/about"]);
assert.deepEqual(homepageVariants("not-a-url"),["not-a-url"]);
console.log("Corporate site protocol fallback regression passed");
