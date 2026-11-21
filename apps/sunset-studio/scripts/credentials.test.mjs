import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeApiKey} from '../server/credentials.mjs';
import {studioFixture as fixture} from './studio-fixture.mjs';

test('API keys trim surrounding whitespace and reject copied punctuation without exposing secrets',()=>{
 assert.equal(normalizeApiKey(' \tprovider-token_123+/=\r\n'),'provider-token_123+/=');
 assert.throws(()=>normalizeApiKey('  '),/不能为空/);
 for(const invalid of ['\u2018','\u2019','中文','\u200b',' ','\n','\r','\0','"',"'",'`']){
  const secret='test-only-'+invalid+'-secret';
  assert.throws(()=>normalizeApiKey(secret),error=>{
   assert.match(error.message,/重新复制完整 Key/);
   assert.ok(!error.message.includes(secret));
   return true;
  });
 }
});

test('invalid model keys do not replace valid config or reach the provider',async()=>{
 const calls=[];
 const f=await fixture({fetchImpl:async(url,init)=>{calls.push(init);new Headers(init.headers);return Response.json({choices:[{message:{content:'{"connected":true}'}}]});}});
 try{
  const saved=await f.post('/api/config',{baseUrl:'https://model.example/v1',model:'original-model',apiKey:'  test-only-valid-key  '});
  assert.equal(saved.status,200);
  const badKey='test-only-'+String.fromCodePoint(8216)+'-secret';
  const rejected=await f.post('/api/config',{model:'replacement-model',apiKey:badKey});
  assert.equal(rejected.status,400);
  const error=await rejected.text();
  assert.match(error,/重新复制完整 Key/);assert.ok(!error.includes(badKey));assert.ok(!error.includes('ByteString'));
  const status=await(await f.get('/api/status')).json();
  assert.equal(status.model,'original-model');assert.equal(status.configured,true);assert.equal(calls.length,0);
  // An empty field still retains the previously saved key.
  assert.equal((await f.post('/api/config',{model:'original-model',apiKey:''})).status,200);
  assert.equal((await f.post('/api/test',{})).status,200);
  assert.equal(calls[0].headers.Authorization,'Bearer test-only-valid-key');
 }finally{f.server.close();}
});

test('invalid initial model keys fail before an upstream turn or speech request',async()=>{
 let calls=0;
 const f=await fixture({initialConfig:{apiKey:'x'.repeat(51)+String.fromCodePoint(8216),model:'mock-only'},fetchImpl:async()=>{calls++;throw new Error('Provider should not be called.');}});
 try{
  for(const [route,body] of [
   ['/api/test',{}],
   ['/api/turn',{message:'中文需求可以正常放在 JSON 中',design:{},image:'data:image/png;base64,aGVsbG8='}],
   ['/api/speech',{text:'A test line.'}]
  ]){
   const response=await f.post(route,body);assert.equal(response.status,400);
   const error=await response.text();assert.match(error,/重新复制完整 Key/);assert.ok(!error.includes('ByteString'));
  }
  assert.equal(calls,0);
 }finally{f.server.close();}
});

test('Fish rejects malformed keys while retaining its previous usable credentials',async()=>{
 const calls=[];
 const f=await fixture({fetchImpl:async(url,init)=>{calls.push(init);new Headers(init.headers);return new Response(new Uint8Array([73,68,51]));}});
 try{
  assert.equal((await f.post('/api/fish/config',{apiKey:'  test-only-fish-key  ',enabled:true})).status,200);
  const badKey='test-only-\u2018-fish-secret';
  const rejected=await f.post('/api/fish/config',{apiKey:badKey});assert.equal(rejected.status,400);
  const error=await rejected.text();assert.match(error,/Fish Audio API Key/);assert.match(error,/重新复制完整 Key/);assert.ok(!error.includes(badKey));
  const response=await f.post('/api/fish/speech',{who:'rick',text:'A test line.'});assert.equal(response.status,200);await response.arrayBuffer();
  assert.equal(calls.length,1);assert.equal(calls[0].headers.Authorization,'Bearer test-only-fish-key');
 }finally{f.server.close();}
});
