import test from 'node:test';
import assert from 'node:assert/strict';
import {fresh,restore,clearDesign,isClearCanvasRequest,parseInstruction} from '../public/model.js';
import {sanitizeArtboard,applyDesignEdit} from '../public/design-schema.js';
import {drawPoster} from '../public/poster.js';
import {LiveStudio} from '../public/live.js';

const drafted=()=>({...fresh(),artboard:{background:'#e9834e',elements:[{id:'title',type:'text',text:'SUNSET SOCIAL',x:80,y:100,size:150}]}});
function renderBlank(state){
 const calls=[],context={clearRect:(...args)=>calls.push(['clear',...args]),fillRect:(...args)=>calls.push(['fill',context.fillStyle,...args])};
 drawPoster({getContext:()=>context},state);
 assert.deepEqual(calls,[['clear',0,0,1080,1350],['fill',state.artboard.background,0,0,1080,1350]]);
}

test('an explicitly empty artboard renders blank instead of restoring the sunset demo',()=>{
 renderBlank({...fresh(),artboard:{background:'#ffffff',elements:[]}});
});

test('removing the last element and assigning an empty artboard are both valid edits',()=>{
 const previous=drafted();
 for(const edit of [{remove:['title']},{artboard:{background:'#ffffff',elements:[]}}]){
  const result=applyDesignEdit(previous,edit);assert.equal(result.changed,true);assert.deepEqual(result.design.artboard.elements,[]);assert.equal(result.design.revision,2);renderBlank(result.design);
 }
 assert.equal(previous.artboard.elements.length,1);
 assert.deepEqual(sanitizeArtboard({background:'#ffffff',elements:[]}).elements,[]);
});

test('clearing resets visible content and survives save, restore and PNG rendering',()=>{
 const previous=drafted();previous.userDecision={finalized:true,revision:1};previous.locked=true;
 const cleared=clearDesign(previous);assert.equal(cleared.userDecision,undefined);assert.equal(cleared.locked,false);assert.equal(cleared.revision,2);assert.deepEqual(cleared.artboard.elements,[]);
 for(const key of ['title','date','location','brand'])assert.equal(cleared[key],'');
 const restored=restore(JSON.parse(JSON.stringify(cleared)));assert.deepEqual(restored.artboard,cleared.artboard);
 for(const key of ['title','date','location','brand'])assert.equal(restored[key],'');
 renderBlank(restored);assert.equal(previous.artboard.elements.length,1);
 assert.deepEqual(applyDesignEdit(drafted(),{clear:true}).design.artboard.elements,[]);
});

test('standalone clear commands are local while negation, partial deletion and new designs retain their meaning',()=>{
 for(const input of ['清空','清空画布','请清空画布。','把画布全部清空','删除所有元素','全部清空','清空内容','清空这个海报','把画布给我清空','把画布上的所有东西全部清空','clear canvas','please clear the canvas','clear everything']){
  assert.equal(isClearCanvasRequest(input),true,input);assert.deepEqual(parseInstruction(input),{kind:'clear'});
 }
 for(const input of ['不要清空画布','别清空','不要删除所有元素','do not clear the canvas','清空标题','只删除日期','清空画布后做一张音乐节海报','clear the canvas and make a new poster'])assert.equal(isClearCanvasRequest(input),false,input);
});

test('a clear request stops pending generation without a model connection and ignores stale replies',async()=>{
 const previousDocument=globalThis.document,nodes=new Map();globalThis.document={querySelector:key=>{if(!nodes.has(key))nodes.set(key,{hidden:false,disabled:false});return nodes.get(key);}};
 let state=drafted(),resolveTurn,calls=0,applied=0,clears=0;
 const studio=Object.create(LiveStudio.prototype);
 Object.assign(studio,{config:{configured:true},history:[],briefMessages:[],epoch:0,voice:async()=>null});
 studio.callbacks={begin(){},stop(){},thinking(){},getDesign:()=>state,getPosterImage:()=> 'data:image/png;base64,aGVsbG8=',notify(){},say:async()=>{},end(){},clear:()=>{state=clearDesign(state);clears++;},apply:()=>{applied++;}};
 studio.request=async()=>{calls++;return await new Promise(resolve=>{resolveTurn=resolve;});};
 try{
  const running=studio.send('Create a poster.');assert.equal(calls,1);
  studio.config.configured=false;await studio.send('清空画布');
  assert.equal(clears,1);assert.equal(studio.running,false);assert.deepEqual(studio.history,[]);assert.deepEqual(studio.briefMessages,[]);assert.equal(studio.controller,null);assert.equal(calls,1);
  resolveTurn({json:async()=>({who:'june',text:'Stale poster',cn:'旧响应',design:drafted()})});await running;
  assert.equal(applied,0);assert.deepEqual(state.artboard.elements,[]);renderBlank(state);
 }finally{globalThis.document=previousDocument;}
});
