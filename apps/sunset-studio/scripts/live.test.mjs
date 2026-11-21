import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBase} from '../server.mjs';
import {studioFixture} from './studio-fixture.mjs';
import {fresh} from '../public/model.js';
import {sanitizeArtboard,applyDesignEdit} from '../public/design-schema.js';

const fixture = fetchImpl => studioFixture({fetchImpl});
test('local config never returns a key and rejects cross-origin writes',async()=>{
 const f=await fixture(async()=>Response.json({choices:[{message:{content:'{"ok":true}'}}]}));try{
 const foreign=await f.post('/api/config',{},{Origin:'https://unrelated.example'});assert.equal(foreign.status,403);
 const r=await f.post('/api/config',{baseUrl:'https://model.example/v1',model:'test-model',apiKey:'private-test-secret'});const text=await r.text();assert.equal(r.status,200);assert.ok(!text.includes('private-test-secret'));
 const status=await (await fetch(f.base+'/api/status')).text();assert.ok(!status.includes('private-test-secret'));
 await f.post('/api/disconnect',{});assert.equal((await (await fetch(f.base+'/api/status')).json()).configured,false);
 }finally{f.server.close();}
});
test('the designer creates the shared artboard, the boss supervises, and the client reviews without editing',async()=>{
 const calls=[];
 const f=await fixture(async(url,init)=>{const payload=JSON.parse(init.body);calls.push(payload);const n=calls.length;return Response.json({choices:[{message:{content:JSON.stringify({speech:n===1?'I made the lunar jazz poster readable. CJ, check the title and venue.':n===2?'The draft is on schedule. CJ, review it before we spend another hour.':'The title and venue meet the brief. This version passes my client review.',subtitle:'按职责完成设计、监督与验收。',decision:n===3?'客户验收通过：标题清晰，场地信息齐全。':'在预算内完成初稿。',changes:'Updated the actual lunar poster',approve:true,reviewStatus:'approved',edit:n===1?{title:'LUNAR JAZZ',artboard:{background:'#17243b',elements:[{id:'title',type:'text',text:'LUNAR JAZZ',x:90,y:120,w:900,size:150,color:'#f5ddaa'}]}}:{title:'UNAUTHORIZED REWRITE',upsert:[{id:'title',size:150+n}],remove:['title']}})}}]});});
 try{
 await f.post('/api/config',{baseUrl:'https://model.example/v1',model:'test-model',apiKey:'test-only'});
 const r=await f.post('/api/meeting',{message:'Create a lunar jazz concert poster',mode:'create',design:fresh()});const events=(await r.text()).trim().split('\n').map(JSON.parse);const turns=events.filter(e=>e.type==='turn');
 assert.equal(calls.length,3);assert.deepEqual(turns.map(e=>e.who),['june','rick','chad']);assert.equal(turns[0].design.title,'LUNAR JAZZ');assert.equal(turns.at(-1).design.artboard.elements[0].size,150);assert.equal(turns.at(-1).design.title,'LUNAR JAZZ');assert.deepEqual(turns.map(turn=>turn.design.revision),[2,2,2]);assert.equal(turns[1].changes,'');assert.equal(turns[2].changes,'');assert.equal(turns[1].reviewStatus,'pending');assert.equal(turns[2].reviewStatus,'approved');assert.equal(turns.at(-1).design.approvals.chad,true);assert.ok(calls[1].messages[1].content.includes(turns[0].text));assert.ok(calls[2].messages[1].content.includes(turns[1].text));assert.equal(events.at(-1).type,'done');
 }finally{f.server.close();}
});
test('canvas updates reject executable structures and preserve unchanged elements',()=>{
 const safe=sanitizeArtboard({background:'url(javascript:alert(1))',elements:[{type:'script',text:'alert(1)'},{id:'heading',type:'text',text:'Hello',size:99999,color:'javascript:x',x:10,y:10}]});assert.equal(safe.elements.length,1);assert.equal(safe.elements[0].size,350);assert.equal(safe.background,'#ead0a0');
 const state={...fresh(),artboard:safe};const result=applyDesignEdit(state,{upsert:[{id:'heading',text:'Changed'}]});assert.equal(result.design.artboard.elements[0].text,'Changed');assert.equal(result.design.artboard.elements[0].x,10);assert.equal(state.artboard.elements[0].text,'Hello');
});
test('base URLs prevent credential-bearing URLs and accidental remote HTTP',()=>{
 assert.throws(()=>normalizeBase('https://user:secret@example.com/v1'));assert.throws(()=>normalizeBase('http://example.com/v1'));assert.equal(normalizeBase('http://127.0.0.1:11434/v1/'),'http://127.0.0.1:11434/v1');assert.equal(normalizeBase('https://api.example.com/v1/chat/completions'),'https://api.example.com/v1');
});
test('provider error messages redact keys',async()=>{
 const f=await fixture(async()=>Response.json({error:{message:'Invalid key private-redact-this'}},{status:401}));try{await f.post('/api/config',{baseUrl:'https://model.example/v1',model:'mock',apiKey:'private-redact-this'});const r=await f.post('/api/test',{});const text=await r.text();assert.ok(!text.includes('private-redact-this'));assert.ok(text.includes('[redacted]'));}finally{f.server.close();}
});
