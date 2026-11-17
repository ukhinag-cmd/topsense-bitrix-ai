'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const g=require('./analytics-memory-guard');
const MB=1024*1024;
test('optional analytics remains enabled at ordinary memory levels',()=>{
 assert.equal(g.shouldDefer({heapUsed:100*MB,rss:400*MB},{}),false);
});
test('defers heavy background work before typical heap exhaustion',()=>{
 assert.equal(g.shouldDefer({heapUsed:500*MB,rss:750*MB},{}),true);
 assert.equal(g.shouldDefer({heapUsed:200*MB,rss:930*MB},{}),true);
});
test('configured threshold is safely bounded',()=>{
 assert.equal(g.limits({TOPSENSE_ANALYTICS_HEAP_GUARD_MB:'9000'}).heapMB,460);
 assert.equal(g.limits({TOPSENSE_ANALYTICS_HEAP_GUARD_MB:'400'}).heapMB,400);
});
