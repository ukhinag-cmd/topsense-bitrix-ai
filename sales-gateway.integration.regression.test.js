'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./sales-gateway');

const appToken = 'integration-token-42';
const dashboardToken = 'dashboard-token-99';
const basic = value => 'Basic ' + Buffer.from(value).toString('base64');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}
function request(port, { method='GET', path='/', headers={}, body=null }={}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname:'127.0.0.1', port, method, path, headers }, res => {
      const chunks=[];
      res.on('data', c=>chunks.push(c));
      res.on('end', ()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    if(body!==null) req.write(body);
    req.end();
  });
}

async function fixture(t, { bitrixToken = appToken } = {}) {
  const upstreamRequests=[];
  const upstream=http.createServer((req,res)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{
      const body=Buffer.concat(chunks).toString('utf8');
      upstreamRequests.push({method:req.method,path:req.url,headers:req.headers,body});
      if(req.url==='/bitrix/events' && req.method==='POST') {
        let token='';
        if((req.headers['content-type']||'').includes('application/json')) {
          try { token=JSON.parse(body).auth?.application_token || ''; } catch {}
        } else {
          token=new URLSearchParams(body).get('auth[application_token]') || '';
        }
        if(token!==appToken) { res.writeHead(401,{'content-type':'application/json'}); return res.end('{"ok":false}'); }
      }
      res.writeHead(200,{'content-type':'application/json'}); res.end('{"ok":true}');
    });
  });
  const upstreamPort=await listen(upstream);
  const handled=[];
  let signalResolve;
  const handledPromise=new Promise(resolve=>{signalResolve=resolve;});
  const fakeSales={
    html:()=>'<h1>test</h1>', status:()=>({ok:true}),
    handleEvent:async evt=>{handled.push(evt);signalResolve(evt);return evt;},
  };
  const gateway=createGateway({upstreamPort,dashboardToken,bitrixToken,salesModule:fakeSales});
  const gatewayPort=await listen(gateway);
  t.after(async()=>{await close(gateway);await close(upstream);});
  return {gatewayPort,upstreamRequests,handled,handledPromise};
}

test('mirrors only a valid authenticated deal event after the existing handler accepts it', async t=>{
  const f=await fixture(t);
  const body='event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=38742&auth%5Bapplication_token%5D='+appToken;
  const response=await request(f.gatewayPort,{method:'POST',path:'/bitrix/events',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  assert.equal(response.status,200);
  await f.handledPromise;
  assert.equal(f.upstreamRequests[0].body,body);
  assert.deepEqual(f.handled[0],{event:'ONCRMDEALUPDATE',dealId:'38742',activityId:null});
});

test('rejects ambiguous or encoded aliases of protected routes before proxying', async t=>{
  const f=await fixture(t);
  for(const path of ['/%73ales','/sales%2Fstatus','/sales%3Fstatus','/bitrix%2Fevents','//sales/../bitrix/events','/SALES','/sales;status']) {
    const response=await request(f.gatewayPort,{path});
    assert.equal(response.status,400,path);
  }
  const queryAlias=await request(f.gatewayPort,{method:'POST',path:'/bitrix/events?bypass=1',headers:{'content-type':'application/x-www-form-urlencoded'},body:'event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=38742&auth%5Bapplication_token%5D='+appToken});
  assert.equal(queryAlias.status,400);
  assert.equal(f.upstreamRequests.length,0);
});

test('fails closed when the Bitrix event token is not configured', async t=>{
  const f=await fixture(t,{bitrixToken:''});
  const body='event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=38742&auth%5Bapplication_token%5D='+appToken;
  const response=await request(f.gatewayPort,{method:'POST',path:'/bitrix/events',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  assert.equal(response.status,503);
  assert.equal(f.upstreamRequests.length,0);
  assert.equal(f.handled.length,0);
});

test('does not mirror a rejected Bitrix event', async t=>{
  const f=await fixture(t);
  const body='event=ONCRMDEALUPDATE&data%5BFIELDS%5D%5BID%5D=38742&auth%5Bapplication_token%5D=wrong';
  const response=await request(f.gatewayPort,{method:'POST',path:'/bitrix/events',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  assert.equal(response.status,401);
  assert.equal(f.handled.length,0);
});

test('Sales endpoints require strict Basic authentication', async t=>{
  const f=await fixture(t);
  assert.equal((await request(f.gatewayPort,{path:'/sales'})).status,401);
  assert.equal((await request(f.gatewayPort,{path:'/sales',headers:{authorization:'Basic c2FsZXM6ZGFzaGJvYXJkLXRva2VuLTk5!!!'}})).status,401);
  assert.equal((await request(f.gatewayPort,{path:'/sales',headers:{authorization:basic('sales:'+dashboardToken)}})).status,200);
});

test('never forwards Proxy-Authorization or malformed Basic credentials upstream', async t=>{
  const f=await fixture(t);
  const response=await request(f.gatewayPort,{path:'/health',headers:{'proxy-authorization':basic('proxy:secret'),authorization:'Basic c2FsZXM6c2VjcmV0!!!'}});
  assert.equal(response.status,200);
  assert.equal('proxy-authorization' in f.upstreamRequests[0].headers,false);
  assert.equal('authorization' in f.upstreamRequests[0].headers,false);
});

test('rejects oversized Bitrix event bodies before forwarding', async t=>{
  const f=await fixture(t);
  const response=await request(f.gatewayPort,{method:'POST',path:'/bitrix/events',headers:{'content-type':'application/x-www-form-urlencoded'},body:'x'.repeat(1024*1024+1)});
  assert.equal(response.status,413);
  assert.equal(f.upstreamRequests.length,0);
});
