import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fresh,restore,parseInstruction,transition} from '../public/model.js';

test('poster changes invalidate approvals and advance revision without mutating history',()=>{
 const original=fresh();original.approvals={rick:true,june:true,chad:true};
 const result=transition(original,'bigger','june');assert.equal(result.logoScale,2.8);assert.equal(result.revision,2);assert.deepEqual(result.approvals,{rick:false,june:false,chad:false});assert.equal(original.logoScale,1);assert.deepEqual(original.approvals,{rick:true,june:true,chad:true});
});
test('the designer revises the poster and each role confirms only its own responsibility',()=>{
 let state=fresh();for(const action of ['bigger','balance','lock'])state=transition(state,action,'june');
 assert.equal(state.logoScale,1);assert.equal(state.locked,true);assert.deepEqual(state.approvals,{rick:false,june:true,chad:false});
 for(const [action,who] of [['brandApproved','june'],['bossApproved','rick'],['clientApproved','chad']])state=transition(state,action,who);
 assert.ok(Object.values(state.approvals).every(Boolean));
 state=transition(state,'minimal','june');assert.deepEqual(state.approvals,{rick:false,june:true,chad:false});
});
test('the client and supervisor cannot change the poster or lock its layout',()=>{
 const original=fresh();original.logoScale=2.8;original.clutter=true;original.approvals={rick:true,june:true,chad:true};
 for(const who of ['chad','rick','unknown'])for(const action of ['bigger','balance','minimal','chaos','budgetCut','lock']){
  const result=transition(original,action,who);assert.deepEqual(result,original,`${who} must not execute ${action}`);assert.notEqual(result,original);assert.notEqual(result.approvals,original.approvals);
 }
 // Direct user controls retain their default designer attribution.
 assert.equal(transition(original,'minimal').layout,'minimal');
});

test('roles cannot approve on behalf of one another or grant unanimous acceptance',()=>{
 const approvalActions={brandApproved:'june',bossApproved:'rick',clientApproved:'chad'};
 for(const [action,allowedWho] of Object.entries(approvalActions))for(const who of ['rick','june','chad','unknown']){
  const original=fresh(),result=transition(original,action,who);assert.equal(result.approvals[allowedWho],who===allowedWho);
  for(const other of ['rick','june','chad'].filter(role=>role!==allowedWho))assert.equal(result.approvals[other],false);
  assert.deepEqual(original.approvals,{rick:false,june:false,chad:false});
 }
 for(const who of ['rick','june','chad'])assert.deepEqual(transition(fresh(),'allApproved',who).approvals,{rick:false,june:false,chad:false});
});

test('every permitted design action invalidates prior client and supervisor approval',()=>{
 for(const action of ['bigger','balance','minimal','chaos','budgetCut','lock']){
  const original=fresh();original.approvals={rick:true,june:true,chad:true};const result=transition(original,action,'june');
  assert.equal(result.approvals.rick,false,action);assert.equal(result.approvals.chad,false,action);
 }
});

test('typed instructions preserve custom text and choose explicit actions',()=>{
 assert.deepEqual(parseInstruction('title: Summer & Friends'),{kind:'edit',patch:{title:'Summer & Friends'}});
 assert.equal(parseInstruction('make it blue').patch.palette,'ocean');assert.equal(parseInstruction('smaller logo').kind,'smaller');assert.equal(parseInstruction('That costs extra').kind,'budget');assert.equal(parseInstruction('invent a spaceship').kind,'unknown');
 assert.equal(parseInstruction("don't make it blue").kind,'unknown');assert.equal(parseInstruction('let them fight').kind,'fight');assert.equal(parseInstruction('everybody stop').kind,'calm');
});
test('saved state is bounded and does not restore stale approvals',()=>{
 const s=restore({title:'',palette:'invalid',logoScale:1000,revision:-3,approvals:{rick:true}});assert.equal(s.palette,'sunset');assert.equal(s.logoScale,1);assert.equal(s.revision,1);assert.equal(s.approvals.rick,false);assert.ok(s.title);
});
test('every dialogue line has a unique identifier, a real role and a shipped voice file',()=>{
 const data=JSON.parse(fs.readFileSync(new URL('../public/dialogue.json',import.meta.url)));const seen=new Set();
 for(const lines of Object.values(data))for(const line of lines){assert.ok(!seen.has(line.id));seen.add(line.id);assert.ok(['rick','june','chad'].includes(line.who));assert.ok(line.text&&line.cn);assert.ok(fs.statSync(new URL(`../public/assets/voices/${line.id}.mp3`,import.meta.url)).size>1000);}
 assert.equal(seen.size,68);
});
