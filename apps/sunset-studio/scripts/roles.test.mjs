import test from 'node:test';
import assert from 'node:assert/strict';
import {ROLE_CONFIG,DESIGNER_ID,canEditDesign,applyAgentDesignEdit} from '../public/roles.js';
import {agentMessages,parseAgentOutput,applyAgentResult,runMeeting} from '../server/agents.mjs';
import {fresh} from '../public/model.js';

const board=()=>({background:'#eeeeee',elements:[{id:'title',type:'text',text:'EXISTING TITLE',x:80,y:100,size:120},{id:'venue',type:'text',text:'VENUE',x:80,y:1200,size:30}]});
const result=extra=>parseAgentOutput(JSON.stringify({speech:'Please check the title and venue against the brief.',changes:'Changed the poster',edit:{},...extra}));

test('only Doubao has design permissions and rejected edits preserve all design state',()=>{
 assert.equal(DESIGNER_ID,'june');
 for(const who of ['rick','chad','unknown']){
  assert.equal(canEditDesign(who),false);
  const current={...fresh(),revision:9,locked:true,artboard:board(),approvals:{rick:true,june:true,chad:true}};
  const snapshot=structuredClone(current);
  const edited=applyAgentDesignEdit(current,{title:'FORBIDDEN',remove:['title'],upsert:[{id:'venue',size:200}],artboard:{background:'#000000',elements:[]}},who);
  assert.equal(edited.changed,false);assert.deepEqual(edited.design,snapshot);assert.deepEqual(current,snapshot);assert.notEqual(edited.design,current);
 }
 assert.equal(ROLE_CONFIG.june.canEdit,true);assert.equal(canEditDesign('june'),true);
});

test('the boss may approve delivery scope without giving client acceptance or changing revisions',()=>{
 const current={...fresh(),revision:5,artboard:board()};
 const edited=applyAgentResult(current,result({approve:true,reviewStatus:'approved',edit:{title:'UNAUTHORIZED',remove:['title']}}),'rick',{mode:'create',step:0});
 assert.equal(edited.changed,false);assert.equal(edited.design.revision,5);assert.equal(edited.design.title,current.title);assert.deepEqual(edited.design.artboard,current.artboard);assert.equal(edited.design.approvals.rick,true);assert.equal(edited.design.approvals.chad,false);assert.equal(edited.reviewStatus,'pending');assert.equal(edited.changes,'');assert.equal(current.approvals.rick,false);
});

test('only client review produces an acceptance verdict and cannot approve a missing draft',()=>{
 const current={...fresh(),artboard:board()};
 const approved=applyAgentResult(current,result({reviewStatus:'approved'}),'chad');assert.equal(approved.reviewStatus,'approved');assert.equal(approved.design.approvals.chad,true);assert.equal(approved.changed,false);
 const rejected=applyAgentResult(approved.design,result({approve:true,reviewStatus:'changes_requested'}),'chad');assert.equal(rejected.reviewStatus,'changes_requested');assert.equal(rejected.design.approvals.chad,false);assert.equal(rejected.design.revision,current.revision);
 const missing=applyAgentResult(fresh(),result({approve:true,reviewStatus:'approved'}),'chad');assert.equal(missing.reviewStatus,'changes_requested');assert.equal(missing.design.approvals.chad,false);
 const designer=applyAgentResult(current,result({approve:true,reviewStatus:'approved'}),'june');assert.equal(designer.reviewStatus,'pending');assert.equal(designer.design.approvals.june,true);assert.equal(designer.design.approvals.chad,false);
});

test('designer creation does not depend on step zero, while later existing artboards permit local changes only',()=>{
 const replacement={background:'#000000',elements:[{id:'new-title',type:'text',text:'NEW DRAFT',x:80,y:100,size:150}]};
 const first=applyAgentResult(fresh(),result({edit:{artboard:replacement}}),'june',{mode:'review',step:4});assert.equal(first.design.artboard.elements[0].text,'NEW DRAFT');
 const current={...fresh(),revision:4,artboard:board()};
 const later=applyAgentResult(current,result({edit:{artboard:replacement,upsert:[{id:'title',size:180}]}}),'june',{mode:'review',step:5});assert.equal(later.design.artboard.elements[0].text,'EXISTING TITLE');assert.equal(later.design.artboard.elements[0].size,180);assert.ok(later.design.artboard.elements.some(e=>e.id==='venue'));assert.equal(later.design.revision,5);
 const newBrief=applyAgentResult(current,result({edit:{artboard:replacement}}),'june',{mode:'create',step:0});assert.equal(newBrief.design.artboard.elements[0].text,'NEW DRAFT');
 const repeated=applyAgentResult(current,result({edit:{artboard:replacement}}),'june',{mode:'create',step:1});assert.equal(repeated.changed,false);assert.equal(repeated.design.revision,4);assert.deepEqual(repeated.design.artboard,current.artboard);
});

test('role-specific prompts expose permissions and give client review concrete acceptance criteria',()=>{
 for(const who of ['rick','june','chad']){
  const messages=agentMessages(who,{message:'Make the venue readable',mode:'review',design:fresh(),history:[],step:2,total:0});
  const input=JSON.parse(messages[1].content);assert.equal(input.role.canEdit,who==='june');
  if(who==='june')assert.match(input.instruction,/first original artboard/);
  if(who==='chad'){assert.match(messages[0].content,/CLIENT and acceptance reviewer/);assert.match(messages[0].content,/readability/);assert.match(input.instruction,/acceptance or revision verdict/);}
  if(who==='rick'){assert.match(input.instruction,/progress, budget and scope/);assert.match(input.instruction,/leave client acceptance to CJ/);}
 }
});

test('fixed debate applies the same edit restrictions and finishes with client review',async()=>{
 const events=[];let calls=0;
 await runMeeting({config:{},message:'Improve the existing poster',mode:'debate',design:{...fresh(),artboard:board()},signal:new AbortController().signal,emit:event=>events.push(structuredClone(event)),complete:async(config,messages)=>{
  calls++;const input=JSON.parse(messages[1].content);const who=input.role.id;
  return JSON.stringify({speech:`This is ${who}'s role-specific response.`,approve:true,reviewStatus:'approved',nextSpeaker:'june',changes:'Changed the title',edit:who==='june'?{upsert:[{id:'title',size:120+calls}]}:{title:'FORBIDDEN',remove:['title']}});
 }});
 const turns=events.filter(event=>event.type==='turn');assert.equal(calls,6);assert.equal(turns[0].who,'june');assert.equal(turns.at(-1).who,'chad');assert.equal(turns.at(-1).reviewStatus,'approved');assert.ok(turns.every(turn=>turn.design.title===fresh().title));
 for(let i=0;i<turns.length;i++)if(turns[i].who!=='june'){assert.equal(turns[i].changes,'');assert.equal(turns[i].design.revision,i?turns[i-1].design.revision:1);assert.ok(turns[i].design.artboard.elements.some(element=>element.id==='title'));}
});
