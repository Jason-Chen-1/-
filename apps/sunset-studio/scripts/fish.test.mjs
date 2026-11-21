import test from 'node:test';
import assert from 'node:assert/strict';
import {studioFixture} from './studio-fixture.mjs';

test('Fish uses its own secret and the three exact user-selected voice IDs',async()=>{
 const calls=[];const {server,base,post}=await studioFixture({fetchImpl:async(url,init)=>{calls.push({url,...init});return new Response(new Uint8Array([73,68,51,1,2,3]),{headers:{'Content-Type':'audio/mpeg'}});}});
 try{
  const blocked=await post('/api/fish/config',{apiKey:'private-fish-test'},{Origin:'https://foreign.example'});assert.equal(blocked.status,403);
  const result=await post('/api/fish/config',{apiKey:'private-fish-test',model:'s2.1-pro',enabled:true});const config=await result.text();assert.ok(!config.includes('private-fish-test'));
  for(const who of ['rick','june','chad']){const r=await post('/api/fish/speech',{who,text:'This is a live design discussion.',emotion:'annoyed'});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'audio/mpeg');await r.arrayBuffer();}
  assert.deepEqual(calls.map(c=>JSON.parse(c.body).reference_id),['010da99c66f44d319159c8588315f22c','33f931ec7a8749c88cda37f1100a4809','0207f2fa259f4c30a4ade44d1d14f810']);
  assert.ok(calls.every(c=>c.url==='https://api.fish.audio/v1/tts'&&c.headers.Authorization==='Bearer private-fish-test'&&c.headers.model==='s2.1-pro'));
  assert.match(JSON.parse(calls[1].body).text,/sarcastic/);
  await post('/api/fish/disconnect',{});const status=await(await fetch(base+'/api/fish/status')).json();assert.equal(status.configured,false);assert.equal(status.enabled,false);
 }finally{server.close();}
});
