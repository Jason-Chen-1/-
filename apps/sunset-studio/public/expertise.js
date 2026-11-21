import {ROLE_CONFIG} from './roles.js';

const normalized=text=>String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
export function inspectDesign(design){
 const elements=design?.artboard?.elements||[],warnings=[];
 if(!elements.length)warnings.push({code:'missing_draft',severity:'blocker',detail:'No original artboard has been created yet.'});
 const text=normalized(elements.filter(element=>element.type==='text').map(element=>element.text).join(' '));
 const copy=['title','date','location','brand'].filter(key=>design?.[key]).map(key=>({field:key,expected:design[key],found:text.includes(normalized(design[key]))}));
 for(const element of elements){
  if(element.type==='text'&&element.text&&element.size<28)warnings.push({code:'small_text',severity:'review',elementId:element.id,detail:'Check whether this supporting text is legible in the rendered screenshot.'});
  if(['rect','ellipse'].includes(element.type)&&!element.rotate&&(element.x<0||element.y<0||element.x+element.w>1080||element.y+element.h>1350))warnings.push({code:'outside_canvas',severity:'review',elementId:element.id,detail:'Geometry crosses the canvas edge; inspect whether this is intentional bleed.'});
 }
 return {revision:design?.revision||1,elementCount:elements.length,copyChecklist:copy,warnings:warnings.slice(0,12),limitations:'Advisory structure checks only. Original user brief and the actual screenshot decide correctness, legibility, contrast and aesthetics.'};
}

export function expertContext(bundle,who,{design,history=[],userInstruction}={}){
 const skill=bundle?.roles?.[who];if(!skill||!ROLE_CONFIG[who])return null;
 const recent=id=>{const entry=history.filter(item=>item.who===id).at(-1);return entry?{speaker:id,feedback:String(entry.decision||entry.text||'').slice(0,600)}:null;};
 const latestUserInstruction=userInstruction||history.filter(item=>item.who==='user').at(-1)?.text||'';
 return {skillId:skill.id,role:who,instructions:skill.instructions,interaction:{highestAuthority:'user',followUserImmediately:true,latestUserInstruction:String(latestUserInstruction).slice(0,1600),priorityOrder:['latest_explicit_user_instruction','compatible_client_feedback','compatible_delivery_advice','designer_discretion'],userMayFinalizeWithoutClientApproval:true},coordination:{designer:'june',supervisor:'rick',customerReviewer:'chad',latestDesignerHandoff:recent('june'),latestDeliveryPriority:recent('rick'),latestClientFinding:recent('chad')},visualSignals:inspectDesign(design)};
}

export function expertRequest(brief,context){
 const {instructions,...signals}=context||{};
 const section=context?'\n\n[STUDIO EXPERT METHOD — NOT POSTER COPY]\n'+instructions+'\nROLE HANDOFF AND INSPECTION DATA:\n'+JSON.stringify(signals)+'\n[END STUDIO METHOD]\nApply this method only to the current role and keep the existing JSON response contract.':'';
 const limit=10000-section.length;if(limit<1000)throw new Error('The reviewed role skill is too large for this API.');
 let request=String(brief);if(request.length>limit){const head=Math.floor((limit-70)*.4);request=request.slice(0,head)+'\n[Earlier context abbreviated; retain latest user requirements.]\n'+request.slice(-(limit-head-70));}
 return request+section;
}
