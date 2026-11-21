import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveStudio} from '../public/live.js';
import {fresh} from '../public/model.js';
import {mergeAgentTurn} from '../public/roles.js';

async function fixture(fn){
 const previousDocument=globalThis.document,nodes=new Map();
 globalThis.document={querySelector:id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,setAttribute(name,value){this[name]=value;}});return nodes.get(id);}};
 let state={...fresh(),artboard:{background:'#ffffff',elements:[{id:'title',type:'text',text:'CURRENT POSTER',x:80,y:100,size:120}]}},finishLine=null;
 const studio=Object.create(LiveStudio.prototype),ends=[];
 Object.assign(studio,{config:{configured:true},history:[],briefMessages:[],epoch:0,voice:async()=>null});
 studio.callbacks={begin(){},stop(){finishLine?.();finishLine=null;},paused(){},thinking(){},getDesign:()=>state,getPosterImage:()=> 'data:image/png;base64,aGVsbG8=',notify:message=>{throw new Error(message);},say:async()=>{},apply:turn=>{state=mergeAgentTurn(state,turn);},end:event=>ends.push(event)};
 const turn=(who,approved=false)=>{const design=structuredClone(state);if(who==='june')design.revision++;design.approvals[who]=approved;return {who,text:'A specific role response.',cn:'具体反馈。',decision:'本轮反馈',heat:10,changes:who==='june'?'Title updated':'',design,reviewStatus:who==='chad'?(approved?'approved':'changes_requested'):'pending'};};
 try{await fn({studio,nodes,ends,turn,getState:()=>state,holdLine:()=>new Promise(resolve=>{finishLine=resolve;})});}finally{studio.cancel();globalThis.document=previousDocument;}
}

test('pause aborts generation, preserves canvas and history, and discards late model replies',async()=>{
 await fixture(async({studio,nodes,turn,getState})=>{
  let resolveRequest,signal,applied=0;studio.request=async(route,data,inputSignal)=>{signal=inputSignal;return await new Promise(resolve=>{resolveRequest=resolve;});};studio.callbacks.apply=()=>{applied++;};
  const before=structuredClone(getState()),running=studio.send('Keep the current title.');
  assert.equal(studio.pause(),true);assert.equal(signal.aborted,true);assert.equal(studio.running,false);assert.equal(studio.paused,true);assert.deepEqual(getState(),before);assert.equal(studio.briefMessages.length,1);
  assert.equal(nodes.get('#meeting-toggle').textContent,'继续讨论');assert.equal(nodes.get('#meeting-toggle').disabled,false);
  resolveRequest({json:async()=>turn('june')});await running;
  assert.equal(applied,0);assert.equal(studio.resumePoint.who,'june');assert.equal(studio.resumePoint.step,0);assert.equal(studio.paused,true);
 });
});

test('resume continues at the next speaker with the current canvas and does not repeat the brief or designer edit',async()=>{
 await fixture(async({studio,turn,getState,holdLine,ends})=>{
  let phase='initial',speaking;const started=new Promise(resolve=>{speaking=resolve;}),calls=[];
  studio.callbacks.say=line=>{if(line.who==='june'){speaking();return holdLine();}return Promise.resolve();};
  studio.request=async(route,data,signal)=>{
   calls.push({phase,...data});
   if(phase==='initial'&&data.who==='rick')return await new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('aborted'));else signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
   return {json:async()=>turn(data.who,data.who==='chad')};
  };
  const initial=studio.send('Make the title clearer.');await started;
  const displayed=structuredClone(getState());assert.equal(displayed.revision,2);
  studio.pause();await initial;assert.equal(studio.resumePoint.who,'rick');assert.equal(studio.resumePoint.step,1);assert.deepEqual(getState(),displayed);
  phase='resumed';await studio.resume();
  const resumed=calls.filter(call=>call.phase==='resumed');assert.deepEqual(resumed.map(call=>call.who),['rick','chad']);assert.equal(resumed[0].step,1);assert.equal(resumed[0].mode,'review');assert.equal(resumed[0].design.revision,2);
  assert.equal(studio.briefMessages.length,1);assert.equal(studio.history.filter(line=>line.who==='user').length,1);assert.equal(getState().revision,2);assert.equal(studio.paused,false);assert.deepEqual(ends,[{mode:'final'}]);
 });
});

test('clearing or starting a new instruction discards a paused continuation',async()=>{
 await fixture(async({studio})=>{
  studio.running=true;studio.currentMeeting={message:'Old brief',mode:'create',brief:'Old brief',step:1,who:'rick'};
  studio.pause();assert.equal(studio.paused,true);studio.clearCanvas();assert.equal(studio.paused,false);assert.equal(studio.resumePoint,null);assert.equal(await studio.resume(),false);
 });
});
