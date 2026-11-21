import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {agentMessages} from '../server/agents.mjs';
import {fresh} from '../public/model.js';
import {expertContext,expertRequest,inspectDesign} from '../public/expertise.js';
import {LiveStudio} from '../public/live.js';
import {mergeAgentTurn} from '../public/roles.js';

const bundle=JSON.parse(fs.readFileSync(new URL('../public/expertise.json',import.meta.url),'utf8'));
const draft=()=>({...fresh(),artboard:{background:'#ffffff',elements:[{id:'title',type:'text',text:'SUNSET SOCIAL',size:150,x:80,y:100,w:900,h:180}]}});

test('each reviewed skill retains its source, license and the exact compiled runtime body',()=>{
 const expected={june:'poster-designer',rick:'delivery-supervisor',chad:'client-reviewer'};
 for(const [who,id] of Object.entries(expected)){
  const skill=bundle.roles[who];assert.equal(skill.id,id);
  const file=fs.readFileSync(new URL(`../skills/roles/${id}/SKILL.md`,import.meta.url),'utf8');
  const body=file.match(/<!-- runtime:start -->([\s\S]*?)<!-- runtime:end -->/)[1].trim();
  assert.equal(skill.instructions,body);assert.equal(skill.digest,createHash('sha256').update(body).digest('hex'));
  const source=bundle.sources.find(item=>item.id===skill.sourceId);assert.ok(source);assert.match(source.commit,/^[a-f0-9]{40}$/);assert.ok(['MIT','Apache-2.0'].includes(source.license));assert.ok(source.url.includes(source.commit));
 }
});

test('actual agent prompts load a distinct professional method and useful feedback from the other roles',()=>{
 const history=[{who:'chad',decision:'请放大日期，标题保持原样。'},{who:'rick',decision:'先解决信息可读性，再做装饰。'},{who:'june',decision:'已调整日期层级，等待客户复查。'}];
 for(const who of ['june','rick','chad']){
  const messages=agentMessages(who,{message:'Keep the date readable',mode:'review',design:draft(),history,step:4,total:0});
  assert.ok(messages[0].content.includes(bundle.roles[who].instructions));
  const context=JSON.parse(messages[1].content).professionalContext;
  assert.equal(context.skillId,bundle.roles[who].id);assert.equal(context.coordination.latestClientFinding.feedback,history[0].decision);assert.equal(context.coordination.latestDeliveryPriority.feedback,history[1].decision);assert.equal(context.coordination.latestDesignerHandoff.feedback,history[2].decision);
 }
});

test('the legacy-server request carries the entire assigned skill and retains the latest requirements within API limits',()=>{
 const context=expertContext(bundle,'june',{design:draft(),history:[]});
 const latest='LATEST REQUIREMENT: exact venue is MOON PARK';
 const brief='ORIGINAL TITLE: SUNSET SOCIAL\n'+'older requirement '.repeat(2000)+latest;
 const request=expertRequest(brief,context);
 assert.ok(request.length<=10000);assert.ok(request.startsWith('ORIGINAL TITLE: SUNSET SOCIAL'));assert.ok(request.includes(latest));assert.ok(request.includes(context.instructions));assert.ok(request.includes('NOT POSTER COPY'));
 const modern=expertRequest(brief,null);assert.ok(modern.length<=10000);assert.ok(modern.includes(latest));assert.ok(!modern.includes(context.instructions));
});

test('layout signals flag inspectable issues without inventing an aesthetic score or automatic acceptance',()=>{
 const design=draft();design.artboard.elements.push({id:'small',type:'text',text:'Date',size:18},{id:'bleed',type:'rect',x:-10,y:0,w:100,h:100});
 const audit=inspectDesign(design);assert.equal(audit.copyChecklist.find(item=>item.field==='title').found,true);assert.ok(audit.warnings.some(item=>item.code==='small_text'&&item.elementId==='small'));assert.ok(audit.warnings.some(item=>item.code==='outside_canvas'&&item.elementId==='bleed'));assert.ok(audit.limitations);assert.equal(audit.score,undefined);assert.equal(audit.approved,undefined);
 assert.ok(inspectDesign(fresh()).warnings.some(item=>item.code==='missing_draft'));
});

test('a normal user instruction outranks conflicting older client and boss advice without a force mode',()=>{
 const userInstruction='把背景改成红色，保留我刚写的标题。';
 const history=[{who:'user',text:'Earlier brief'},{who:'chad',decision:'我个人要求紫色背景。'},{who:'rick',decision:'先按客户说的改紫色。'}];
 const context=expertContext(bundle,'june',{design:draft(),history,userInstruction});
 assert.equal(context.interaction.highestAuthority,'user');assert.equal(context.interaction.followUserImmediately,true);assert.equal(context.interaction.latestUserInstruction,userInstruction);
 assert.equal(context.interaction.priorityOrder[0],'latest_explicit_user_instruction');assert.equal(context.interaction.userOverride,undefined);
 assert.ok(expertRequest(userInstruction,context).includes(userInstruction));
 const messages=agentMessages('june',{message:userInstruction,mode:'create',design:draft(),history:[...history,{who:'user',text:userInstruction}],step:0,total:0});
 assert.equal(JSON.parse(messages[1].content).professionalContext.interaction.latestUserInstruction,userInstruction);
});

test('an already-running server receives role skills without restart and the collaboration stops after client acceptance',async()=>{
 const previousDocument=globalThis.document,nodes=new Map();
 globalThis.document={querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,{hidden:false,disabled:false});return nodes.get(selector);}};
 let state=draft();const calls=[],ends=[];
 const studio=Object.create(LiveStudio.prototype);
 Object.assign(studio,{config:{configured:true},expertise:bundle,expertiseReady:Promise.resolve(true),history:[],briefMessages:[],epoch:0,voice:async()=>null});
 studio.callbacks={begin(){},stop(){},thinking(){},getDesign:()=>state,getPosterImage:()=> 'data:image/png;base64,aGVsbG8=',notify:message=>{throw new Error(message);},say:async()=>{},end:event=>ends.push(event),apply:turn=>{state=mergeAgentTurn(state,turn);}};
 studio.request=async(route,data)=>{
  calls.push(data);const design=structuredClone(state);if(data.who==='june')design.revision++;design.approvals[data.who]=true;
  return {json:async()=>({who:data.who,text:'A specific professional response.',cn:'具体的岗位反馈。',decision:data.who+' handoff',heat:10,changes:data.who==='june'?'Title refined':'',design,reviewStatus:data.who==='chad'?'approved':'pending'})};
 };
 try{
  await studio.send('Create a coherent sunset event poster.');
  assert.deepEqual(calls.map(call=>call.who),['june','rick','chad']);assert.deepEqual(ends,[{mode:'final'}]);assert.equal(state.clientReview.status,'approved');
  for(const call of calls)assert.ok(call.message.includes(bundle.roles[call.who].instructions));
  assert.ok(calls[1].message.includes('june handoff'));assert.ok(calls[2].message.includes('rick handoff'));
 }finally{globalThis.document=previousDocument;}
});
