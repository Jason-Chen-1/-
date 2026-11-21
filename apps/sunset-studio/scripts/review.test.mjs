import test from 'node:test';
import assert from 'node:assert/strict';
import {fresh,restore,transition} from '../public/model.js';
import {mergeAgentTurn,applyAgentDesignEdit,finalizeByUser,reopenByUser} from '../public/roles.js';
import {LiveStudio} from '../public/live.js';

const draft=()=>({...fresh(),artboard:{background:'#ffffff',elements:[{id:'title',type:'text',text:'CLIENT BRIEF',x:80,y:100,size:120}]}});

test('supervisor turns cannot replace the canvas and preserve an existing client acceptance',()=>{
 let state=draft();
 state=mergeAgentTurn(state,{who:'chad',design:{...state,approvals:{rick:false,june:false,chad:true}},reviewStatus:'approved',decision:'符合需求，客户验收通过。'});
 assert.equal(state.approvals.chad,true);
 const reviewed=mergeAgentTurn(state,{who:'rick',design:{...draft(),revision:999,title:'UNAUTHORIZED',artboard:null,approvals:{rick:true,june:true,chad:false}},reviewStatus:'approved'});
 assert.equal(reviewed.title,state.title);assert.deepEqual(reviewed.artboard,state.artboard);assert.equal(reviewed.revision,state.revision);
 assert.equal(reviewed.approvals.rick,true);assert.equal(reviewed.approvals.june,false);assert.equal(reviewed.approvals.chad,true);assert.equal(reviewed.clientReview.status,'approved');
 assert.deepEqual(state.clientReview.feedback,'符合需求，客户验收通过。');
});

test('a designer revision invalidates client acceptance and a client revision request overrides approval',()=>{
 const old={...draft(),approvals:{rick:true,june:true,chad:true},clientReview:{status:'approved',feedback:'Old acceptance',revision:1}};
 const changed=mergeAgentTurn(old,{who:'june',design:{...old,revision:2,title:'UPDATED DRAFT'},reviewStatus:'approved'});
 assert.equal(changed.title,'UPDATED DRAFT');assert.equal(changed.clientReview.status,'pending');assert.equal(changed.approvals.chad,false);assert.equal(changed.approvals.rick,false);
 const rejected=mergeAgentTurn(changed,{who:'chad',design:{...changed,approvals:{rick:true,june:true,chad:true}},reviewStatus:'changes_requested',decision:'日期太小，请豆包修改。'});
 assert.equal(rejected.approvals.chad,false);assert.equal(rejected.clientReview.status,'changes_requested');assert.equal(rejected.approvals.rick,false);assert.equal(rejected.revision,2);
});

test('user finalization needs no client approval and blocks later agent edits until explicitly reopened',()=>{
 const original=draft();original.clientReview={status:'changes_requested',feedback:'CJ still wants purple.'};
 const finalized=finalizeByUser(original);
 assert.equal(finalized.locked,true);assert.equal(finalized.userDecision.finalized,true);assert.equal(finalized.approvals.chad,false);assert.equal(finalized.revision,original.revision);
 for(const who of ['june','rick','chad']){
  assert.equal(applyAgentDesignEdit(finalized,{title:'FORBIDDEN'},who).changed,false);
  assert.deepEqual(mergeAgentTurn(finalized,{who,design:{...draft(),revision:999},reviewStatus:'approved'}),finalized);
 }
 assert.deepEqual(transition(finalized,'bigger','june'),finalized);
 const restored=restore(JSON.parse(JSON.stringify(finalized)));assert.equal(restored.userDecision.finalized,true);assert.equal(restored.locked,true);
 const reopened=reopenByUser(finalized);assert.equal(reopened.userDecision,undefined);assert.equal(applyAgentDesignEdit(reopened,{title:'USER REQUESTED UPDATE'},'june').changed,true);assert.equal(finalized.userDecision.finalized,true);
});

async function meetingFixture(fn){
 const prior=globalThis.document,nodes=new Map();
 globalThis.document={querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,{hidden:false,disabled:false});return nodes.get(selector);}};
 let state=draft();const calls=[],ends=[];
 const studio=Object.create(LiveStudio.prototype);
 Object.assign(studio,{config:{configured:true},history:[],briefMessages:[],epoch:0,voice:async()=>null});
 studio.callbacks={begin(){},stop(){},thinking(){},getDesign:()=>state,getPosterImage:()=> 'data:image/png;base64,aGVsbG8=',notify:message=>{throw new Error(message);},say:async()=>{},end:event=>ends.push(event),apply:turn=>{state=mergeAgentTurn(state,turn);}};
 studio.request=async(route,data)=>{calls.push(data);return {json:async()=>({who:data.who,text:'A specific role response.',cn:'角色反馈。',decision:'具体反馈',heat:10,changes:'',design:structuredClone(state),reviewStatus:data.who==='chad'?'changes_requested':'pending'})};};
 try{await fn({studio,calls,ends,getState:()=>state});}finally{globalThis.document=prior;}
}

test('continuous meetings start with Doubao, then delivery supervision and client review',async()=>{
 await meetingFixture(async({studio,calls})=>{
  const apply=studio.callbacks.apply;
  studio.callbacks.apply=turn=>{apply(turn);if(calls.length===3)studio.cancel();};
  await studio.send('Create the requested poster');
  assert.deepEqual(calls.map(call=>call.who),['june','rick','chad']);
 });
});

test('final acceptance routes client requests to the designer and ends only after CJ approves',async()=>{
 await meetingFixture(async({studio,calls,ends,getState})=>{
  studio.request=async(route,data)=>{
   calls.push(data);const approved=data.who==='chad'&&calls.length===3;
   const design=structuredClone(getState());if(data.who==='june')design.revision++;
   design.approvals[data.who]=approved;
   return {json:async()=>({who:data.who,text:'Please fix the date, then I will review.',cn:'请修改日期，再验收。',decision:approved?'客户验收通过。':'请豆包放大日期。',heat:10,changes:data.who==='june'?'Date enlarged':'',design,reviewStatus:data.who==='chad'?(approved?'approved':'changes_requested'):'pending'})};
  };
  await studio.send('CJ, review the actual current version.','final');
  assert.deepEqual(calls.map(call=>call.who),['chad','june','chad']);assert.ok(calls.every(call=>call.mode==='final'));
  assert.equal(getState().clientReview.status,'approved');assert.deepEqual(ends,[{mode:'final'}]);
 });
});

test('requesting an opinion on a user-finalized version never starts an automatic redesign',async()=>{
 await meetingFixture(async({studio,calls,ends,getState})=>{
  const current=getState();current.userDecision={finalized:true,revision:current.revision};current.locked=true;
  await studio.send('CJ, give your opinion on my final version.','final');
  assert.deepEqual(calls.map(call=>call.who),['chad']);assert.deepEqual(ends,[{mode:'review_only'}]);assert.equal(getState().userDecision.finalized,true);
 });
});
