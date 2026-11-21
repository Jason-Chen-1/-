import test from 'node:test';import assert from 'node:assert/strict';import {SpeechInput} from '../public/speech-input.js';
function fixture(){const sessions=[],timers=new Map(),submitted=[],texts=[];let id=0;class Recognition{constructor(){sessions.push(this);}start(){}stop(){this.onend();}abort(){}}
const input=new SpeechInput({Recognition,onSubmit:text=>submitted.push(text),onText:text=>texts.push(text),schedule:fn=>{timers.set(++id,fn);return id;},unschedule:key=>timers.delete(key)});
const result=(session,text,final=true)=>{const item=[{transcript:text}];item.isFinal=final;session.onresult({resultIndex:0,results:[item]});};return {input,sessions,submitted,texts,result,tick:()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());}};}
test('silence reconnects and keeps text without submitting, manual stop submits once',()=>{const f=fixture();f.input.start();assert.equal(f.sessions[0].continuous,true);f.result(f.sessions[0],'请做一张');f.sessions[0].onend();assert.deepEqual(f.submitted,[]);f.tick();f.result(f.sessions[1],'海报',false);f.input.stop();assert.deepEqual(f.submitted,['请做一张海报']);f.tick();assert.equal(f.sessions.length,2);assert.equal(f.submitted.length,1);});
test('repeated interim updates replace rather than duplicate and final stop retains interim',()=>{const f=fixture();f.input.start();f.result(f.sessions[0],'海',false);f.result(f.sessions[0],'海洋',false);f.result(f.sessions[0],'海洋海报',true);f.input.stop();assert.deepEqual(f.submitted,['海洋海报']);});
test('pause/clear cancellation cannot submit stale text or restart a session',()=>{const f=fixture();f.input.start();f.result(f.sessions[0],'旧要求');f.sessions[0].onend();f.input.cancel();f.tick();assert.equal(f.sessions.length,1);assert.deepEqual(f.submitted,[]);});
test('permission failure retains text but never submits or loops',()=>{const f=fixture();f.input.start();f.result(f.sessions[0],'草稿');f.sessions[0].onerror({error:'not-allowed'});f.tick();assert.equal(f.input.active,false);assert.deepEqual(f.submitted,[]);assert.equal(f.texts.at(-1),'草稿');});
test('stop during restart gap finishes with accumulated text',()=>{const f=fixture();f.input.start();f.result(f.sessions[0],'完整要求');f.sessions[0].onend();f.input.stop();f.tick();assert.deepEqual(f.submitted,['完整要求']);assert.equal(f.sessions.length,1);});
test('a late callback from the old recognizer cannot erase text entered after reconnect',()=>{
 const f=fixture();f.input.start();const stale=f.sessions[0].onresult;
 f.result(f.sessions[0],'Check');f.sessions[0].onend();f.tick();f.result(f.sessions[1],'NASA');
 stale({resultIndex:0,results:[[{transcript:'stale'}]]});
 f.input.stop();assert.deepEqual(f.submitted,['Check NASA']);
});
test('removed interim text does not leak into a later submission',()=>{
 const f=fixture();f.input.start();const session=f.sessions[0];
 const confirmed=[{transcript:'保留'}],interim=[{transcript:'误识别'}];
 session.onresult({resultIndex:0,results:[confirmed,interim]});
 session.onresult({resultIndex:1,results:[confirmed]});f.input.stop();
 assert.deepEqual(f.submitted,['保留']);
});
test('manual stop waits for final speech and cannot submit twice',()=>{
 const f=fixture();f.input.start();const session=f.sessions[0];
 session.stop=()=>{};f.result(session,'未完',false);f.input.stop();f.input.stop();
 assert.deepEqual(f.submitted,[]);
 f.result(session,'已经说完');session.onend();f.tick();
 assert.deepEqual(f.submitted,['已经说完']);
});
