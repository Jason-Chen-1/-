import {fresh,restore,parseInstruction,transition,cleanBrief,clearDesign} from './model.js';
import {drawPoster} from './poster.js';
import {StudioScene} from './illustrated-scene.js';
import {LiveStudio} from './live.js';
import {SpeechInput} from './speech-input.js';
import {ROLE_CONFIG,DESIGNER_ID,canEditDesign,isDesignAction,mergeAgentTurn,finalizeByUser,reopenByUser} from './roles.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const roles=ROLE_CONFIG;
let state=fresh();try{state=restore(JSON.parse(localStorage.getItem('sunset-design')));}catch{}
let scene;try{scene=new StudioScene($('#stage'),id=>focusPerson(id));}catch(e){$('#scene-error').hidden=false;console.error(e);}
let dialogue={},started=false,busy=false,muted=false,subtitles=true,history=[],notes=[],receiptUnlocked=false,startTime=0,sequenceToken=0,lineFinish=null,toastTimer,changeTimer,focusTimer,pendingDesignAction=null;
let audioContext,analyser,audioSource,asideSource,asideTimer,amplitudeFrame,speechAudio=new Audio(),asideAudio=new Audio(),radioNodes=[],radioGain,radioTimer,radioOn=false;
let demoPlayback=null,demoResumePoint=null;
speechAudio.preload='auto';
const canvas=$('#poster');
const live=new LiveStudio({
 getDesign:()=>state,
 getPosterImage:()=>{const preview=document.createElement('canvas');preview.width=648;preview.height=810;preview.getContext('2d').drawImage(canvas,0,0,648,810);return preview.toDataURL('image/jpeg',.88);},
 notify,
 research:event=>renderResearch(event),
 toggleMeeting:()=>toggleMeeting(),
 paused:()=>{stopRecording();$('#agent-decision').textContent='讨论已暂停，当前海报与会话已保留。';$('#voice-title').textContent='讨论已暂停。';$('#voice-hint').textContent='点击“继续讨论”接着进行，也可输入新要求';},
 clear:()=>{stopRecording();$('#talk-input').value='';snapshot();state=clearDesign(state);pendingDesignAction=null;render();markChange('画布已清空');$('#agent-decision').textContent='画布已清空，已停止生成。等待你的新要求。';$('#caption-en').textContent='Canvas cleared.';$('#caption-cn').textContent='已清空画布，不会自动恢复默认海报。';$('#voice-title').textContent='画布已清空。';$('#voice-hint').textContent='给出新需求后再开始 · 可撤销恢复上一版';},
 begin:event=>{demoPlayback=null;demoResumePoint=null;if(!event?.resuming&&event?.mode!=='final')state=reopenByUser(state);pendingDesignAction=null;sequenceToken++;stopLine();audioInit();if(!started){started=true;startTime=Date.now();}$('#welcome').hidden=true;$('#voice-title').textContent='豆包按你的要求修改。';$('#voice-hint').textContent='用户最新要求优先 · CJ 与 Boss 提供意见';setBusy(true);render();},
 stop:()=>{demoPlayback=null;demoResumePoint=null;scene?.setReviewing(null);showDecisionSources([]);$('#agent-decision').textContent='已暂停。当前海报已保留。';$('#voice-title').textContent='Meeting paused.';$('#voice-hint').textContent='点击说话 · 给他们新要求后继续';sequenceToken++;stopLine();setBusy(false);scene?.setActive(null);$$('.person-tag').forEach(el=>el.classList.remove('thinking','speaking'));$('#waveform').classList.remove('active');},
 cutIn:()=>{stopLine();},
 thinking:e=>{scene?.setReviewing(e.who);$$('.person-tag').forEach(el=>el.classList.toggle('thinking',el.dataset.person===e.who));$('#speaking-status').textContent=roles[e.who].name+' IS THINKING';if(!live.speaking){showDecisionSources([]);$('#agent-decision').textContent=e.who===DESIGNER_ID?'豆包正在设计 · 唯一可修改画布的角色':e.who==='chad'?'CJ 正在评估作品 · 客户验收':'Boss 正在监督进度与交付范围';}},
 apply:turn=>{const next=mergeAgentTurn(state,turn);if(next.revision!==state.revision)snapshot();state=next;setHeat(turn.heat);render();if(canEditDesign(turn.who)&&turn.changes)markChange(roles[turn.who].name+': '+turn.changes);$('#agent-decision').textContent=roles[turn.who].name+' · '+turn.decision;showDecisionSources(turn.sources||[]);$$('.person-tag').forEach(el=>el.classList.remove('thinking'));},
 say:line=>speak(line),
 end:event=>{setBusy(false);scene?.setActive(null);scene?.setReviewing(null);$$('.person-tag').forEach(el=>el.classList.remove('thinking','speaking'));$('#waveform').classList.remove('active');$('#voice-title').textContent='你来决定。';$('#voice-hint').textContent=event?.mode==='review_only'?'最终版本保持锁定 · 客户意见不会自动触发返工':'说出新的要求，豆包继续执行，或由你拍板交付';if(event?.mode==='final')complete();}
});
$('.director-desk').prepend($('#welcome'));
$('#workbench-button').addEventListener('click',()=>$('.workspace').scrollIntoView({behavior:'smooth',block:'start'}));
$('#close-workbench').addEventListener('click',()=>{document.body.classList.remove('workbench-open');$('#workbench-button').setAttribute('aria-expanded','false');});
const fullscreenButton=$('#fullscreen-button');
const isFullscreen=()=>!!(document.fullscreenElement||document.webkitFullscreenElement);
function syncFullscreen(){
 const active=isFullscreen();
 fullscreenButton.setAttribute('aria-pressed',String(active));
 fullscreenButton.setAttribute('aria-label',active?'Exit full screen':'Full screen');
 fullscreenButton.title=active?'退出全屏 / Exit full screen':'全屏 / Full screen';
 document.body.classList.toggle('studio-fullscreen',active);
}
fullscreenButton.addEventListener('click',async()=>{
 $('#studio-menu').open=false;
 try{
  if(isFullscreen()){
   const exit=document.exitFullscreen||document.webkitExitFullscreen;
   if(exit)await exit.call(document);
  }else{
   const root=document.documentElement;
   const enter=root.requestFullscreen||root.webkitRequestFullscreen;
   if(!enter)throw new Error('Fullscreen unavailable');
   await enter.call(root);
  }
 }catch{notify('当前内嵌浏览器不支持全屏。请在 Chrome 打开本页，再点右上角全屏。');}
 syncFullscreen();
});
document.addEventListener('fullscreenchange',syncFullscreen);
document.addEventListener('webkitfullscreenchange',syncFullscreen);
syncFullscreen();
function save(){try{localStorage.setItem('sunset-design',JSON.stringify(state));}catch{}}
function render(focus=''){
 drawPoster(canvas,state,focus);$('#revision').textContent='V.'+String(state.revision).padStart(2,'0');
 $('#workbench-button span').textContent='V.'+String(state.revision).padStart(2,'0');
 $('#project-status').textContent=(state.title.toUpperCase()||'空白画布')+' / LIVE POSTER';
 canvas.setAttribute('aria-label','Live editable poster: '+(state.title||'空白画布'));
 const review=state.clientReview||{status:state.approvals.chad?'approved':'pending',feedback:''};
 const empty=Array.isArray(state.artboard?.elements)&&!state.artboard.elements.length;
 const reviewLabel=empty?'画布为空 · 等待你的新要求':review.status==='approved'?'CJ · 客户验收通过':review.status==='changes_requested'?'CJ · 客户要求修改':'CJ · 等待客户评审';
 $('#approval-count').textContent=reviewLabel;$('#client-review').textContent=reviewLabel+(review.feedback?'：'+review.feedback:'');$('#client-review').dataset.status=review.status;
 $('#user-authority').textContent=state.userDecision?.finalized?'你已拍板并锁定 V.'+String(state.revision).padStart(2,'0')+' · 角色意见不能改动此版本':'你拥有最终决定权 · 他们可以反对，你可以拍板';$('#user-authority').dataset.finalized=String(!!state.userDecision?.finalized);
 for(const id of Object.keys(roles)){const el=$('#approve-'+id);el.textContent=state.approvals[id]?'✓':'○';el.classList.toggle('approved',state.approvals[id]);}
 $('#lock-button').textContent=state.locked?'Brief locked ✓':'Lock the brief';$('#undo-button').disabled=!history.length;
 $$('.swatch').forEach(b=>b.classList.toggle('active',b.dataset.palette===state.palette));save();
}
function notify(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3500);}
function markChange(message){$('.poster-holder').classList.remove('updated');requestAnimationFrame(()=>$('.poster-holder').classList.add('updated'));$('#poster-change').textContent=message;$('#poster-change').hidden=false;$('#live-editor').textContent=message;clearTimeout(changeTimer);changeTimer=setTimeout(()=>$('#poster-change').hidden=true,2600);}
function snapshot(){history.push(structuredClone(state));if(history.length>30)history.shift();}
function edit(patch){snapshot();state={...reopenByUser(state),...patch,locked:false,revision:state.revision+1,approvals:{rick:false,june:false,chad:false},clientReview:{status:'pending',feedback:'设计已更新，等待 CJ 验收。'}};render();markChange('豆包 · 已更新设计，等待客户评审。');}
function apply(action,who=DESIGNER_ID){
 if(state.userDecision?.finalized)return;
 if(action==='allApproved')action=who==='chad'?'clientApproved':who==='rick'?'bossApproved':'brandApproved';
 if(isDesignAction(action)&&!canEditDesign(who)){pendingDesignAction=action;if(who==='chad'){state.approvals.chad=false;state.clientReview={status:'changes_requested',feedback:'客户提出了新的修改要求，等待豆包执行。',revision:state.revision};render();}$('#agent-decision').textContent=roles[who].name+' 提出修改要求 · 等待豆包执行';return;}
 const previous=state;const next=transition(state,action,who);if(next.revision!==state.revision)snapshot();if(isDesignAction(action))next.clientReview={status:'pending',feedback:'豆包已更新设计，等待 CJ 验收。'};state=next;
 if(who==='chad'&&action==='clientApproved')state.clientReview={status:'approved',feedback:'CJ 已验收当前版本。',revision:state.revision};render();
 const changes={bigger:'已按客户要求调整 Logo',balance:'已恢复版面层级',minimal:'已精简版面',chaos:'已尝试客户提出的视觉方向',budgetCut:'已按预算缩减设计范围',lock:'已锁定当前需求'};
 if(state.revision!==previous.revision&&changes[action])markChange('豆包 · '+changes[action]);
 if(action==='receipt'){receiptUnlocked=true;$('#receipt-count').textContent='1';notify('Caught a contradiction. Try “You literally said…”');}
 if(action==='complete')complete();
}
function addNote(line){notes.push({...line,time:Date.now()});$('#note-total').textContent=notes.length;}
function setBusy(value){busy=value;document.body.classList.toggle('is-busy',value);$('#skip-button').hidden=!value;$('#speaking-status').textContent=value?'LIVE / ENGLISH':'YOUR TURN';$('#turn-label').textContent=value?'YOU CAN INTERRUPT.':'MAKE YOUR CASE.';syncMeetingControl();}
function syncMeetingControl(){
 if(!demoPlayback&&!demoResumePoint){live.syncMeetingControl();return;}
 for(const id of ['meeting-toggle','pause-meeting']){const button=$('#'+id);button.disabled=false;button.textContent=demoResumePoint?'继续讨论':'暂停讨论';button.setAttribute('aria-pressed',String(!!demoResumePoint));}
}
function toggleMeeting(){
 if(demoPlayback&&busy){const point={...demoPlayback};live.cancel();demoResumePoint=point;stopRecording();$('#voice-title').textContent='讨论已暂停。';$('#voice-hint').textContent='点击“继续讨论”从下一句接着进行';syncMeetingControl();return;}
 if(demoResumePoint){const point=demoResumePoint;demoResumePoint=null;play(point.group,point.index);return;}
 live.togglePause();
}
function audioInit(){
 if(!audioContext){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;audioContext=new AC();analyser=audioContext.createAnalyser();analyser.fftSize=256;audioSource=audioContext.createMediaElementSource(speechAudio);audioSource.connect(analyser);asideSource=audioContext.createMediaElementSource(asideAudio);asideSource.connect(analyser);analyser.connect(audioContext.destination);}
 if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});
}
function stopLine(){
 clearTimeout(asideTimer);asideAudio.pause();scene?.setInterjection(null);$('#interjection').hidden=true;
 speechAudio.pause();speechAudio.onended=null;speechAudio.onerror=null;window.speechSynthesis?.cancel();
 if(lineFinish){const finish=lineFinish;lineFinish=null;finish();}
 cancelAnimationFrame(amplitudeFrame);scene?.setAmplitude(0);
}
function animateMouth(){
 const data=new Uint8Array(128);const tick=()=>{let level=0;if(analyser&&(!speechAudio.paused||!asideAudio.paused)){analyser.getByteTimeDomainData(data);let sum=0;for(const value of data)sum+=(value-128)**2;level=Math.min(1,Math.sqrt(sum/data.length)/27);}else if(window.speechSynthesis?.speaking){level=.2+Math.abs(Math.sin(performance.now()*.021))*.6;}scene?.setAmplitude(level);amplitudeFrame=requestAnimationFrame(tick);};tick();
}
function setHeat(value){scene?.setHeat(value);$('#heat-fill').style.width=value+'%';$('#heat-label').textContent=value>85?'SOMEBODY CALL THE DESIGNER.':value>55?'THIS IS GETTING PERSONAL.':value>25?'CREATIVE DIFFERENCES.':"EVERYBODY'S CHILL. FOR NOW.";}
function interject(id){
 const line=dialogue.asides.find(l=>l.id===id);if(!line)return;scene?.setInterjection(line.who);const bubble=$('#interjection');bubble.querySelector('strong').textContent=roles[line.who].name+' —';bubble.querySelector('span').textContent=line.text;bubble.style.left=({rick:'19%',june:'50%',chad:'81%'})[line.who];bubble.hidden=false;
 asideAudio.src=`assets/voices/${id}.mp3`;asideAudio.muted=muted;asideAudio.volume=.85;addNote(line);
 const end=()=>{scene?.setInterjection(null);bubble.hidden=true;};asideAudio.onended=end;asideAudio.onerror=end;asideAudio.play().catch(end);
}
function speak(line){
 return new Promise(resolve=>{
  let done=false;let timeout;const finish=()=>{if(done)return;done=true;clearTimeout(timeout);speechAudio.pause();cancelAnimationFrame(amplitudeFrame);scene?.setAmplitude(0);if(lineFinish===finish)lineFinish=null;resolve();};lineFinish=finish;
  scene?.setActive(line.who);const role=roles[line.who];$('#speaker-name').textContent=`${role.name} / ${role.label}`;$('#speaker-name').style.color=role.color;
  $('#caption-en').textContent=line.text;$('#caption-cn').textContent=line.cn;$('#caption-cn').hidden=!subtitles;
  $$('.person-tag').forEach(e=>e.classList.toggle('speaking',e.dataset.person===line.who));$('#waveform').classList.add('active');
 if(!line.live&&canEditDesign(line.who)&&pendingDesignAction){const requested=pendingDesignAction;pendingDesignAction=null;if(!isDesignAction(line.action))apply(requested,line.who);}
 if(line.action)apply(line.action,line.who);if(line.heat!==undefined)setHeat(line.heat);if(line.focus){render(line.focus);clearTimeout(focusTimer);focusTimer=setTimeout(()=>render(),2800);}addNote(line);
  clearTimeout(asideTimer);if(line.interject)asideTimer=setTimeout(()=>interject(line.interject.id),line.interject.at*1000);
  speechAudio.muted=muted;speechAudio.playbackRate=line.live?1.14:1.08;
  if(line.live&&!line.audioUrl){timeout=setTimeout(finish,30000);animateMouth();fallback(line,finish);return;}
  speechAudio.src=line.audioUrl||`assets/voices/${line.id}.mp3`;
  speechAudio.onended=finish;
  speechAudio.onerror=()=>fallback(line,finish);
  timeout=setTimeout(finish,22000);animateMouth();
  speechAudio.play().catch(()=>fallback(line,finish));
 });
}
function fallback(line,finish){
 if(muted||!('speechSynthesis' in window)){setTimeout(finish,Math.max(1600,line.text.length*40));return;}
 const utterance=new SpeechSynthesisUtterance(line.text);utterance.lang='en-US';const voices=speechSynthesis.getVoices().filter(v=>/en[-_]US/i.test(v.lang));
 utterance.voice=voices.find(v=>line.who==='june'?/Samantha|Aria|Jenny|female/i.test(v.name):line.who==='rick'?/Guy|Reed|Alex|David/i.test(v.name):/Christopher|Rocko|Eddy|Mark/i.test(v.name))||voices[0];utterance.rate=line.live?1.2:1.06;utterance.pitch=line.who==='rick'?.9:line.who==='june'?1.05:1;
 utterance.onend=finish;utterance.onerror=finish;speechSynthesis.speak(utterance);
}
async function play(group,startIndex=0){
 if(!dialogue[group]){notify('The meeting is still loading. Try again in a moment.');return;}
 if(!started){started=true;startTime=Date.now();$('#welcome').hidden=true;}
 const token=++sequenceToken;stopLine();audioInit();demoResumePoint=null;demoPlayback={group,index:startIndex};setBusy(true);
 for(let index=startIndex;index<dialogue[group].length;index++){if(token!==sequenceToken)return;demoPlayback={group,index:index+1};await speak(dialogue[group][index]);if(token!==sequenceToken)return;await new Promise(r=>setTimeout(r,220));}
 if(token===sequenceToken){demoPlayback=null;setBusy(false);scene?.setActive(null);$('#waveform').classList.remove('active');$$('.person-tag').forEach(e=>e.classList.remove('speaking'));}
}
function act(action){
 if(action==='clear'){live.clearCanvas();return;}
 if(live.enabled){
  const requests={fight:['CJ evaluates the poster as the client, Boss supervises scope, and only Doubao implements justified edits. Debate specific design choices while respecting my latest brief.','debate'],bigger:["Consider CJ's client feedback. Boss checks scope and only Doubao edits the poster.",'debate'],calm:['Resolve the feedback. Only Doubao implements changes; CJ decides whether the finished poster meets the brief.','settle'],receipt:['Identify a real contradiction in the discussion and ask Doubao to address any justified design change. Do not invent a quote.','debate'],deadline:['Boss checks the deadline and scope. Doubao implements essential changes, then CJ reviews quality.','settle'],budget:['Boss supervises budget. CJ explains what matters, and Doubao alone changes the design.','debate'],lock:['Confirm the requirements. Doubao implements any remaining fixes and CJ reviews the result.','settle'],ship:['CJ, give a final client review of the visible poster. Approve only if it meets the brief; otherwise request specific changes from Doubao. Boss supervises delivery but cannot approve on behalf of CJ.','final']};
  const [message,mode]=requests[action]||['Review the current poster and improve it.','review'];live.send(message,mode);return;
 }
 if(action==='fight'){state.locked=false;render();}
 if(action==='receipt'&&!receiptUnlocked){notify('First let Chad ask for a bigger logo. Then keep the receipt.');return;}
 if(state.locked&&action==='bigger'){notify('You locked the brief. Edit the brief to reopen design changes.');return;}
 if(action==='ship'&&state.logoScale>1){pendingDesignAction='balance';}
 play(action);
}
function focusPerson(id){if(document.body.classList.contains('focus-layout'))return;scene?.setFocus(id);$('#wide-button').hidden=!scene?.focus;}
function download(){
 const exportCanvas=document.createElement('canvas');exportCanvas.width=1080;exportCanvas.height=1350;drawPoster(exportCanvas,state);
 exportCanvas.toBlob(blob=>{if(!blob){notify('PNG export failed. Please try again.');return;}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(state.title.replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'').slice(0,50)||'untitled')+'-sunset-studio.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);notify('Poster exported. Your evening is officially yours.');},'image/png');
}
function complete(){
 render();
 const allApproved=state.approvals.chad===true,userFinal=state.userDecision?.finalized===true;$('.complete-stamp').textContent=userFinal?'YOUR DECISION.':allApproved?'CLIENT APPROVED.':'AWAITING REVIEW.';$('#complete-dialog h2').textContent=userFinal?'你拍板，交付这一版。':allApproved?'CJ approved this version.':'Export the current version.';
 const elapsed=Math.floor((Date.now()-(startTime||Date.now()))/1000);$('#stat-time').textContent=`${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`;$('#stat-revisions').textContent=state.revision;
 $('#complete-dialog .completion-copy').textContent=userFinal?'当前版本已由你锁定并导出。CJ 可以保留意见，你的最终决定无需客户批准。':allApproved?'豆包完成设计，Boss 监督交付，客户 CJ 已验收当前版本。':'客户 CJ 尚未验收。你可以导出当前版本，或让豆包继续修改。';
 $('#session-footer').textContent=allApproved?'APPROVED. THE BEACH IS CALLING.':'YOUR DESIGN. YOUR FINAL CALL.';$('#complete-dialog').showModal();
}
function stopRecording(){
 recognition?.cancel();recognition=null;
}
function userFinal(){
 live.cancel();pendingDesignAction=null;stopRecording();
 state=finalizeByUser(state);render();$('#agent-decision').textContent='用户已拍板。豆包与 CJ 可以保留意见，当前版本不再接受自动修改。';download();complete();
}
async function start(){audioInit();await document.fonts.ready;if(live.enabled){live.send($('#talk-input').value.trim()||`Create an original poster for ${state.title}. ${state.date}. ${state.location}. Use a West Coast sunset aesthetic. Discuss your different ideas and build the actual design.`,'create');return;}play('intro');}
$('#start-button').addEventListener('click',start);
$$('[data-action]').forEach(button=>button.addEventListener('click',()=>act(button.dataset.action)));
$$('[data-person]').forEach(button=>button.addEventListener('click',()=>focusPerson(button.dataset.person)));
$('#wide-button').addEventListener('click',()=>{if(scene)scene.focus=null;$('#wide-button').hidden=true;});
$('#skip-button').addEventListener('click',()=>stopLine());
$('#sound-button').addEventListener('click',()=>{muted=!muted;speechAudio.muted=muted;asideAudio.muted=muted;if(muted)window.speechSynthesis?.cancel();$('#sound-button').setAttribute('aria-pressed',String(muted));$('#sound-button').setAttribute('aria-label',muted?'Unmute voices':'Mute voices');$('#sound-button').textContent=muted?'♩':'♪';});
$('#captions-button').addEventListener('click',()=>{subtitles=!subtitles;$('#caption-cn').hidden=!subtitles;$('#captions-button').classList.toggle('selected',subtitles);$('#captions-button').setAttribute('aria-pressed',String(subtitles));});
$('#help-button').addEventListener('click',()=>$('#help-dialog').showModal());
$$('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
$('#edit-button').addEventListener('click',()=>{for(const key of ['title','date','location','brand'])$('#brief-'+key).value=state[key];$('#brief-dialog').showModal();});
$('#save-brief').addEventListener('click',()=>{const patch={};for(const [key,limit]of [['title',35],['date',45],['location',45],['brand',12]])patch[key]=cleanBrief($('#brief-'+key).value,limit,state[key]);$('#brief-dialog').close();if(live.enabled){live.send('Update the poster to these exact details, preserving the overall direction: '+JSON.stringify(patch),'create');return;}edit(patch);play('edit');});
$('.close[value="cancel"]').formNoValidate=true;
$('#brief-form').addEventListener('submit',e=>{if(e.submitter?.value!=='cancel'){e.preventDefault();$('#save-brief').click();}});
$$('[data-palette]').forEach(b=>b.addEventListener('click',()=>{if(live.enabled){live.send('Change the current poster to a '+b.dataset.palette+' color direction. Debate the exact palette briefly and update the actual artwork.','create');return;}if(state.palette===b.dataset.palette)return;edit({palette:b.dataset.palette});play('color');}));
$('#undo-button').addEventListener('click',()=>{if(!history.length)return;live.cancel();sequenceToken++;stopLine();setBusy(false);scene?.setActive(null);state=history.pop();render();markChange('Back to the previous version.');});
$('#lock-button').addEventListener('click',()=>act('lock'));$('#ship-button').addEventListener('click',()=>act('ship'));
$('#client-review-button').addEventListener('click',()=>act('ship'));
$('#meeting-toggle').addEventListener('click',toggleMeeting);
$('#clear-canvas-button').addEventListener('click',()=>live.clearCanvas());
$('#user-final-button').addEventListener('click',userFinal);
$('#download-button').addEventListener('click',download);$('#keep-editing').addEventListener('click',()=>$('#complete-dialog').close());
$('#export-current').addEventListener('click',download);
$('#menu-export').addEventListener('click',()=>{$('#studio-menu').open=false;download();});
const sessionExport=document.createElement('button');sessionExport.className='text-button';sessionExport.textContent='导出会话 · JSON';sessionExport.id='export-session';$('.top-actions').append(sessionExport);sessionExport.addEventListener('click',()=>{const blob=new Blob([JSON.stringify({application:'Sunset Studio',exportedAt:new Date().toISOString(),brief:live.briefMessages,history:live.history,research:live.researchLog||[],design:state},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='sunset-session-'+Date.now()+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),3000);});
$('#type-instead').addEventListener('click',()=>{document.body.classList.toggle('typing');$('#studio-menu').open=false;if(document.body.classList.contains('typing'))$('#talk-input').focus();});
$('#studio-menu').addEventListener('click',e=>{if(e.target.closest('button'))$('#studio-menu').open=false;});
$('#notes-button').addEventListener('click',()=>{const list=$('#note-list');list.replaceChildren();if(!notes.length){const p=document.createElement('p');p.textContent='No questionable opinions. Yet.';list.append(p);}for(const note of notes.slice(-40).reverse()){const div=document.createElement('div');div.className='receipt-note';const label=document.createElement('small');label.textContent=roles[note.who].name;const p=document.createElement('p');p.textContent=note.text;div.append(label,p);if(['review3','big1','big4'].includes(note.id)&&receiptUnlocked){const b=document.createElement('button');b.textContent='Bring this up';b.addEventListener('click',()=>{$('#notes-dialog').close();act('receipt');});div.append(b);}list.append(div);}$('#notes-dialog').showModal();});
function submitText(text){if(!text.trim())return;if(live.enabled){$('#talk-input').value='';live.send(text,/吵|争论|互怼|argue|debate|fight/i.test(text)?'debate':'create');return;}const parsed=parseInstruction(text);if(parsed.patch)edit(parsed.patch);$('#talk-input').value='';act(parsed.kind);}
let recognition;
$('#talk-form').addEventListener('submit',e=>{
 e.preventDefault();
 if(recognition?.active)recognition.stop();
 else submitText($('#talk-input').value);
});
function sourceLink(source,label){
 let url;try{url=new URL(source.url);}catch{return null;}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
 const link=document.createElement('a');
 link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';
 link.textContent=label||source.title||url.hostname;
 link.title=source.title||url.hostname;
 return link;
}
function showDecisionSources(sources){
 const links=sources.slice(0,3).map(source=>sourceLink(source,source.domain+' ↗')).filter(Boolean);
 const element=$('#decision-sources');
 element.replaceChildren(...links);
 element.hidden=!links.length;
}
function renderResearch(event){
 const panel=$('#research-panel'),list=$('#research-list'),badge=$('#search-badge');
 let row=[...list.children].find(item=>item.dataset.id===event.id);
 if(event.status==='reset'){
  list.replaceChildren();panel.open=false;
 }else if(event.status==='cancelled'){
  row?.remove();
 }else{
  if(!row){row=document.createElement('li');row.dataset.id=event.id;list.prepend(row);while(list.children.length>12)list.lastChild.remove();}
  row.dataset.status=event.status;
  row.replaceChildren();
  const heading=document.createElement('strong');
  heading.textContent=(roles[event.who]?.name||'Studio')+' · '+{searching:'正在检索',failed:'检索未完成',done:'已取得来源'}[event.status];
  const query=document.createElement('p');query.textContent=event.query;row.append(heading,query);
  if(event.error||event.provider){const meta=document.createElement('small');meta.textContent=event.error||event.provider;row.append(meta);}
  for(const source of (event.results||[]).slice(0,5)){
   const link=sourceLink(source,source.title+' ↗');if(!link)continue;
   link.title=[source.domain,source.snippet].filter(Boolean).join(' · ');
   row.append(link);
  }
 }
 const count=list.querySelectorAll('li[data-status="done"]').length;
 const searching=list.querySelector('li[data-status="searching"] strong');
 badge.textContent=searching?.textContent||'三角色可联网检索';
 badge.dataset.searching=String(!!searching);
 $('#research-count').textContent=count+' 次成功';
 panel.hidden=!list.children.length;
}
$('#mic-button').addEventListener('click',()=>{
 if(recognition?.active){recognition.stop();return;}
 if(!live.config.configured&&live.enabled){live.open();return;}
 const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
 const input=$('#talk-input'),button=$('#mic-button');
 if(!Recognition){document.body.classList.add('typing');input.focus();notify('当前浏览器不支持语音识别，可以直接输入。');return;}
 live.cancel();
 recognition=new SpeechInput({Recognition,
  onText:text=>{input.value=text;$('#voice-title').textContent=text.slice(-82)||'正在聆听…';},
  onState:(active,phase)=>{
   button.classList.toggle('listening',active);
   button.setAttribute('aria-pressed',String(active));
   button.setAttribute('aria-label',active?'结束录音并提交':'开始语音输入');
   button.disabled=phase==='finishing';
   input.readOnly=active;
   $('#say-button').textContent=active?'结束并提交':'发送';
   $('#say-button').disabled=phase==='finishing';
   $('#voice-title').textContent=input.value.slice(-82)||(active?'正在聆听…':'点击麦克风说话');
   $('#voice-hint').textContent={
    starting:'等待麦克风 · 再点一下结束并提交',
    listening:'停顿时继续聆听 · 再点一下结束并提交',
    reconnecting:'正在续听 · 已保留前面的文字',
    finishing:'正在接收最后的文字…',
    idle:'中文 / English',
   }[phase];
  },
  onSubmit:submitText,
  onError:error=>{
   document.body.classList.add('typing');input.focus();
   $('#voice-hint').textContent=input.value?'草稿可以编辑后发送':'可重新开启麦克风或使用文字输入';
   notify(['not-allowed','service-not-allowed'].includes(error)?'请允许麦克风权限，或继续输入文字。':'语音服务暂不可用。');
  }
 });
 recognition.start(input.value);
});
$('#reset-button').addEventListener('click',()=>{live.resetSession();stopRecording();$('#talk-input').value='';sequenceToken++;stopLine();state=fresh();setHeat(0);notes=[];history=[];receiptUnlocked=false;started=false;$('#welcome').hidden=false;$('#receipt-count').textContent='0';$('#note-total').textContent='0';$('#caption-en').textContent="The sun sets. The revisions don't.";$('#caption-cn').textContent='太阳会下山，最终版不会。';$('#speaker-name').textContent='YOUR FIRST DAY. THEIR FINAL FINAL VERSION.';setBusy(false);scene?.setActive(null);$$('.person-tag').forEach(e=>e.classList.remove('speaking'));$('#waveform').classList.remove('active');render();});
function radio(){
 audioInit();if(!audioContext)return;radioOn=!radioOn;$('#music-button').setAttribute('aria-pressed',String(radioOn));$('#music-button').textContent=radioOn?'♫ Studio radio · on':'♫ Studio radio · off';
 if(!radioOn){clearInterval(radioTimer);radioNodes.forEach(n=>{try{n.stop();}catch{}});radioNodes=[];radioGain?.disconnect();return;}
 radioGain=audioContext.createGain();radioGain.gain.value=.026;radioGain.connect(audioContext.destination);
 const chords=[[146.83,174.61,220,261.63],[130.81,164.81,196,246.94],[110,130.81,164.81,196],[130.81,164.81,196,220]];let step=0;
 const tick=()=>{const now=audioContext.currentTime;const chord=chords[step++%chords.length];for(const [i,freq] of chord.entries()){const o=audioContext.createOscillator(),g=audioContext.createGain();o.type='sine';o.frequency.value=freq;o.connect(g);g.connect(radioGain);g.gain.setValueAtTime(0,now);g.gain.linearRampToValueAtTime(.22,now+.2+i*.08);g.gain.exponentialRampToValueAtTime(.001,now+3.7);o.start(now);o.stop(now+4);radioNodes.push(o);o.onended=()=>{radioNodes=radioNodes.filter(n=>n!==o);g.disconnect();};}};tick();radioTimer=setInterval(tick,4000);
}
$('#music-button').addEventListener('click',radio);
document.addEventListener('keydown',e=>{if(e.key===' '&&busy&&!['INPUT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName)&&!$('dialog[open]')){e.preventDefault();stopLine();}});
render();document.fonts.ready.then(()=>render());
fetch('./dialogue.json').then(r=>{if(!r.ok)throw new Error('Dialogue load failed');return r.json();}).then(data=>{dialogue=data;$('#start-button').disabled=false;}).catch(()=>{$('#start-button').disabled=true;notify('Dialogue could not load. Reload the page to retry.');});
$('#start-button').disabled=true;
window.addEventListener('pagehide',()=>{stopRecording();live.cancel();sequenceToken++;stopLine();clearInterval(radioTimer);audioContext?.suspend();});
