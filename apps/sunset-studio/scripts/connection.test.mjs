import test from 'node:test';
import assert from 'node:assert/strict';
import {studioFixture} from './studio-fixture.mjs';
import {requestErrorMessage} from '../server/network.mjs';
import {LiveStudio} from '../public/live.js';

test('model and Fish Audio requests stop at redirects and keep credentials on the configured origin', async () => {
 const calls = [];
 const {server, post} = await studioFixture({fetchImpl: async (url, options) => {
  calls.push({url, redirect: options.redirect});
  return new Response(null, {status: 307, headers: {Location: 'https://unexpected.example/'}});
 }});
 try {
  assert.equal((await post('/api/config', {baseUrl: 'https://model.example/v1', model: 'fixture', apiKey: 'fixture-model-key'})).status, 200);
  assert.equal((await post('/api/fish/config', {apiKey: 'fixture-fish-key', enabled: true})).status, 200);
  for (const route of ['/api/test', '/api/fish/speech']) {
   const response = await post(route);
   assert.equal(response.status, 400);
   const {error} = await response.json();
   assert.match(error, /HTTP 307/);
   assert.doesNotMatch(error, /unexpected\.example|fixture-.*-key/);
  }
  assert.deepEqual(calls, [
   {url: 'https://model.example/v1/chat/completions', redirect: 'manual'},
   {url: 'https://api.fish.audio/v1/tts', redirect: 'manual'},
  ]);
 } finally { server.close(); }
});

test('saving config does not verify a connection, and a failed retest clears verification',async()=>{
 let fail=false;
 const {server,get,post}=await studioFixture({fetchImpl:async()=>{
  if(fail)throw new TypeError('fetch failed',{cause:Object.assign(new Error('sensitive transport detail'),{code:'ECONNRESET'})});
  return Response.json({choices:[{message:{content:'{"connected":true}'}}]});
 }});
 const status=async()=>await(await get('/api/status')).json();
 try{
  assert.equal((await status()).verified,false);assert.equal((await status()).speechMode,'fish');
  const saved=await(await post('/api/config',{model:'mock',apiKey:'test-only-connection-key'})).json();
  assert.equal(saved.configured,true);assert.equal(saved.verified,false);assert.equal(saved.speechMode,'fish');
  assert.equal((await(await post('/api/test',{})).json()).verified,true);
  assert.equal((await status()).verified,true);
  fail=true;
  const failed=await post('/api/test',{});assert.equal(failed.status,400);
  const error=await failed.text();assert.match(error,/无法连接 API/);assert.ok(!error.includes('sensitive transport detail'));assert.ok(!error.includes('test-only-connection-key'));
  assert.equal((await status()).verified,false);assert.equal((await status()).configured,true);
  await post('/api/config',{model:'mock-new',apiKey:''});assert.equal((await status()).verified,false);
 }finally{server.close();}
});

test('network errors distinguish DNS, proxy refusal, timeout and certificate failures',()=>{
 const transport=code=>new TypeError('fetch failed',{cause:Object.assign(new Error('private diagnostic'),{code})});
 assert.match(requestErrorMessage(transport('ENOTFOUND')),/DNS/);
 assert.match(requestErrorMessage(transport('ECONNREFUSED')),/代理拒绝连接/);
 assert.match(requestErrorMessage(transport('UND_ERR_CONNECT_TIMEOUT')),/超时/);
 assert.match(requestErrorMessage(transport('CERT_HAS_EXPIRED')),/证书验证失败/);
 assert.match(requestErrorMessage(new TypeError('fetch failed',{cause:new AggregateError([Object.assign(new Error(),{code:'ECONNREFUSED'})])})),/代理拒绝连接/);
 assert.equal(requestErrorMessage(new Error('API 401: Invalid API key')),'API 401: Invalid API key');
});

test('Fish voice mode keeps speech separate from OpenAI model requests',async()=>{
 const signal=new AbortController().signal,notices=[];let fishCalls=0,openAiSpeechCalls=0;
 const studio={
  fish:{ready:Promise.resolve(),config:{configured:true,enabled:true},speak:async()=>{fishCalls++;return 'blob:test-only-fish-voice';}},
  config:{speechMode:'fish'},callbacks:{notify:message=>notices.push(message)},
  request:async()=>{openAiSpeechCalls++;throw new Error('OpenAI speech must not be called.');}
 };
 assert.equal(await LiveStudio.prototype.voice.call(studio,{text:'A test line.',who:'rick'},signal),'blob:test-only-fish-voice');
 assert.equal(fishCalls,1);assert.equal(openAiSpeechCalls,0);
 studio.fish.speak=async()=>{throw new Error('Fish temporarily unavailable');};
 assert.equal(await LiveStudio.prototype.voice.call(studio,{text:'A test line.',who:'rick'},signal),null);
 studio.fish.config.configured=false;
 assert.equal(await LiveStudio.prototype.voice.call(studio,{text:'A test line.',who:'rick'},signal),null);
 assert.equal(openAiSpeechCalls,0);assert.ok(notices.length>0);
});
