import test from 'node:test';
import assert from 'node:assert/strict';
import {makeServer} from '../server.mjs';
import {fresh} from '../public/model.js';

test('continuous turn sees a current screenshot and cannot wipe the canvas during refinement',async()=>{
 const calls=[];const server=makeServer({initialConfig:{apiKey:'mock-only',model:'mock'},fetchImpl:async(url,init)=>{const p=JSON.parse(init.body);calls.push(p);return Response.json({choices:[{message:{content:JSON.stringify({speech:'That title is hiding. Let it do its job.',subtitle:'标题躲起来了，让它发挥作用。',decision:'提升标题层级。',nextSpeaker:'june',edit:{artboard:{background:'#ffffff',elements:[{id:'bad',type:'text',text:'Replacement'}]},upsert:[{id:'title',size:180}]}})}}]});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const design={...fresh(),artboard:{background:'#eeeeee',elements:[{id:'title',type:'text',text:'NIGHT SHIFT',x:80,y:100,w:900,size:120},{id:'venue',type:'text',text:'VENICE SKATEPARK',x:80,y:1200,w:900,size:30}]}};
 try{const r=await fetch(base+'/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Improve this skate poster',mode:'review',step:9,who:'june',design,history:[{who:'chad',text:'Make the title tiny.'}],image:'data:image/png;base64,aGVsbG8='})});const turn=await r.json();assert.equal(r.status,200);assert.equal(calls.length,1);assert.equal(turn.vision,true);assert.equal(turn.step,10);assert.equal(turn.design.artboard.elements.find(e=>e.id==='title').size,180);assert.ok(turn.design.artboard.elements.some(e=>e.id==='venue'));assert.equal(calls[0].messages[1].content[1].type,'image_url');assert.match(calls[0].messages[1].content[0].text,/Make the title tiny/);
 }finally{server.close();}
});

test('continuous client and supervisor calls cannot execute model-supplied canvas changes',async()=>{
 const server=makeServer({initialConfig:{apiKey:'mock-only',model:'mock'},fetchImpl:async()=>Response.json({choices:[{message:{content:JSON.stringify({speech:'Make the venue readable before the next review.',decision:'请豆包放大场地文字。',approve:true,reviewStatus:'changes_requested',changes:'Deleted the title',edit:{title:'INVALID',palette:'lime',artboard:{background:'#000000',elements:[{id:'bad',type:'text',text:'INVALID'}]},remove:['title'],upsert:[{id:'venue',size:200}]}})}}]})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const design={...fresh(),revision:7,artboard:{background:'#eeeeee',elements:[{id:'title',type:'text',text:'NIGHT SHIFT',x:80,y:100,size:120},{id:'venue',type:'text',text:'VENICE SKATEPARK',x:80,y:1200,size:30}]}};
 try{for(const who of ['rick','chad']){
  const response=await fetch(base+'/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Review this skate poster',mode:'create',step:0,who,design,history:[],image:'data:image/png;base64,aGVsbG8='})});
  const turn=await response.json();assert.equal(response.status,200);assert.equal(turn.design.revision,7);assert.equal(turn.design.title,design.title);assert.equal(turn.design.palette,design.palette);assert.equal(turn.design.artboard.elements.find(e=>e.id==='title').text,'NIGHT SHIFT');assert.equal(turn.design.artboard.elements.find(e=>e.id==='venue').size,30);assert.equal(turn.changes,'');assert.equal(turn.reviewStatus,who==='chad'?'changes_requested':'pending');assert.equal(turn.design.approvals[who],who==='rick');
 }}finally{server.close();}
});

test('the first designer turn can create an artboard after an earlier client turn',async()=>{
 const server=makeServer({initialConfig:{apiKey:'mock-only',model:'mock'},fetchImpl:async()=>Response.json({choices:[{message:{content:JSON.stringify({speech:'Here is the first draft. CJ, check the date and title.',edit:{artboard:{background:'#17243b',elements:[{id:'title',type:'text',text:'FIRST DRAFT',x:80,y:100,size:120}]}}})}}]})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const response=await fetch(base+'/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Create a poster',mode:'review',step:2,who:'june',design:fresh(),history:[{who:'user',text:'Create a poster'},{who:'chad',text:'Please make the first draft.'}],image:'data:image/png;base64,aGVsbG8='})});
  const turn=await response.json();assert.equal(response.status,200);assert.equal(turn.design.artboard.elements[0].text,'FIRST DRAFT');assert.equal(turn.design.revision,2);assert.equal(turn.reviewStatus,'pending');
 }finally{server.close();}
});
