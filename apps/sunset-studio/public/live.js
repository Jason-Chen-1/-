const $=s=>document.querySelector(s);
import {FishVoices} from './fish.js';
import {AdminSettings} from './admin.js';
import {DESIGNER_ID} from './roles.js';
import {expertContext,expertRequest} from './expertise.js';
import {isClearCanvasRequest} from './model.js';
import {readTurnResponse} from './research.js';
export class LiveStudio {
 constructor(callbacks){this.callbacks=callbacks;this.enabled=false;this.config={configured:false,verified:false};this.connectionState='unconfigured';this.connectionError='';this.history=[];this.briefMessages=[];this.researchLog=[];try{const saved=JSON.parse(sessionStorage.getItem('sunset-meeting'));if(saved){this.history=(saved.history||[]).slice(-24);this.briefMessages=(saved.briefMessages||[]).slice(-8);this.researchLog=(saved.research||[]).slice(-40);}}catch{}for(const event of this.researchLog)this.callbacks.research?.(event);this.epoch=0;this.controller=null;this.speaking=false;this.admin=new AdminSettings(callbacks.notify);this.fish=new FishVoices(callbacks.notify,this.admin);this.expertiseReady=this.refreshExpertise();this.bind();this.refresh();}
 async refreshExpertise(){try{const r=await fetch('./expertise.json');if(!r.ok)throw new Error();const bundle=await r.json();if(!['june','rick','chad'].every(who=>typeof bundle.roles?.[who]?.instructions==='string'))throw new Error();this.expertise=bundle;return true;}catch{this.expertise=null;return false;}}
 async researchTurn(data,signal){
  const {professional,...payload}=data;
  const message=expertRequest(data.message,professional);
  const response=await this.request('/api/turn',{...payload,message},signal,{'Accept':'application/x-ndjson'});
  return readTurnResponse(response,event=>{if(!signal?.aborted)this.recordResearch(event);});
 }
 recordResearch(event){
  this.pendingResearch??=new Map();
  if(event.status==='searching'){
   this.pendingResearch.set(event.id,event);
  }else{
   this.pendingResearch.delete(event.id);
   this.researchLog=[...(this.researchLog||[]),event].slice(-40);
   this.saveSession();
  }
  this.callbacks.research?.(event);
 }
 saveSession(){
  try{sessionStorage.setItem('sunset-meeting',JSON.stringify({history:this.history,briefMessages:this.briefMessages,research:this.researchLog}));}catch{}
 }
 resetSession(){
  this.cancel();this.history=[];this.briefMessages=[];this.researchLog=[];this.pending=null;
  try{sessionStorage.removeItem('sunset-meeting');}catch{}
  this.callbacks.research?.({status:'reset'});
 }
 async request(route,data,signal,headers={}){const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data),signal});if(!response.ok){let body={};try{body=await response.json();}catch{}throw new Error(body.error||`Request failed (${response.status})`);}return response;}
 async refresh(){try{const r=await fetch('/api/status');if(!r.ok)throw new Error();this.config=await r.json();this.connectionState=this.config.verified===true?'verified':this.config.configured?'saved':'unconfigured';this.connectionError='';}catch{this.config={configured:false,verified:false};this.connectionState='unconfigured';this.connectionError='无法读取站点的模型配置。';}if(!this.manualMode)this.enabled=this.config.configured&&this.config.verified;this.status();}
 status(){
  const c=this.config,state=this.connectionState,pending=state==='saving'||state==='testing',connected=c.configured&&c.verified===true&&!pending&&state!=='failed';
  $('#connect-button').classList.toggle('connected',connected);
  $('#connection-status').textContent=state==='saving'?'正在保存模型设置…':state==='testing'?'正在测试模型连接…':state==='failed'?'模型连接失败。':connected?'模型已连接。':c.configured?'模型设置已保存，等待验证。':'填写模型服务的地址、名称和 API Key。';
  const mode=$('#demo-mode');mode.hidden=!connected;mode.textContent=this.enabled?'切换到离线演示':'切换到实时 Agent';
  $('#live-badge').textContent=!this.enabled?'OFFLINE DEMO':pending?'TESTING CONNECTION':connected?'LIVE AGENTS':state==='failed'?'CONNECTION FAILED':c.configured?'CONNECTION UNVERIFIED':'CONNECT YOUR MODEL';
  const badge=$('#search-badge');if(badge)badge.hidden=!this.enabled||!c.webSearch;
 }
 syncVoiceSettings(){const mode=$('#api-speech').value;$('#api-tts-settings').hidden=mode!=='api';$('#fish-voice-settings').hidden=mode!=='fish';}
 async open(){await this.admin.open(async()=>{await this.refresh();const c=this.config;$('#api-base').value=c.baseUrl||'https://api.openai.com/v1';$('#api-model').value=c.model||'gpt-5.4-mini';$('#api-key').value='';$('#api-key').placeholder=c.configured?'留空保留现有 Key':'输入模型服务的 API Key';$('#api-style').value=c.apiStyle||'chat';$('#api-json').checked=c.jsonMode!==false;$('#api-speech').value=['fish','browser','api'].includes(c.speechMode)?c.speechMode:'fish';$('#api-tts-model').value=c.ttsModel||'gpt-4o-mini-tts';this.syncVoiceSettings();$('#config-error').textContent=this.connectionError;$('#config-dialog').showModal();});}
 bind(){
  $('#connect-button').addEventListener('click',()=>this.open());
  $('#config-close').addEventListener('click',()=>$('#config-dialog').close());
  $('#config-dialog').addEventListener('close',()=>{$('#api-key').value='';});
  $('#api-speech').addEventListener('change',()=>this.syncVoiceSettings());
  $('#api-save').addEventListener('click',async()=>{
   const button=$('#api-save');button.disabled=true;this.connectionState='saving';this.connectionError='';this.status();$('#config-error').textContent='';
   const data={baseUrl:$('#api-base').value,model:$('#api-model').value,apiKey:$('#api-key').value,apiStyle:$('#api-style').value,jsonMode:$('#api-json').checked,speechMode:$('#api-speech').value,ttsModel:$('#api-tts-model').value};
   try{this.config=await (await this.request('/api/config',data)).json();this.config.verified=false;$('#api-key').value='';data.apiKey='';this.connectionState='testing';this.status();const result=await(await this.request('/api/test',{})).json();if(result.verified!==true)throw new Error('连接未验证，请重试。');this.config.verified=true;this.connectionState='verified';this.enabled=true;this.manualMode=false;this.status();$('#config-dialog').close();this.callbacks.notify('思考模型已连接。');if(this.pending){const pending=this.pending;this.pending=null;this.send(pending.message,pending.mode);}}
   catch(e){await this.refresh();this.connectionState='failed';this.connectionError=e.message;this.status();$('#config-error').textContent=this.connectionError;}
   finally{$('#api-key').value='';data.apiKey='';button.disabled=false;}
  });
  $('#api-disconnect').addEventListener('click',async()=>{try{this.config=await (await this.request('/api/disconnect',{})).json();this.cancel();this.enabled=false;this.connectionState='unconfigured';this.connectionError='';this.status();$('#api-key').value='';$('#config-error').textContent='模型 Key 已清除。';}catch(e){$('#config-error').textContent=e.message;}});
  $('#demo-mode').addEventListener('click',()=>{this.cancel();this.enabled=!this.enabled;this.manualMode=!this.enabled;this.status();});
  $('#stop-live').addEventListener('click',()=>this.pause());$('#pause-meeting').addEventListener('click',()=>this.callbacks.toggleMeeting?this.callbacks.toggleMeeting():this.togglePause());
 }
 syncMeetingControl(){
  const button=$('#meeting-toggle');if(button){button.textContent=this.paused?'继续讨论':'暂停讨论';button.disabled=!this.running&&!this.paused;button.setAttribute?.('aria-pressed',String(!!this.paused));}
  const menu=$('#pause-meeting');if(menu){menu.disabled=!this.running&&!this.paused;menu.textContent=this.paused?'继续讨论':'暂停讨论';}
 }
 cancel(){this.epoch++;this.running=false;this.currentMeeting=null;this.resumePoint=null;this.paused=false;this.releaseRendered?.();this.releaseRendered=null;this.controller?.abort();this.controller=null;for(const event of this.pendingResearch?.values()||[])this.callbacks.research?.({...event,status:'cancelled'});this.pendingResearch?.clear();this.speaking=false;this.callbacks.stop();$('#stop-live').hidden=true;$('#pause-meeting').disabled=true;this.syncMeetingControl();}
 pause(){
  if(!this.running)return false;
  const point=this.currentMeeting?{...this.currentMeeting}:null;this.cancel();
  if(point){this.resumePoint=point;this.paused=true;}this.callbacks.paused?.();this.syncMeetingControl();return true;
 }
 async resume(){
  if(!this.paused||!this.resumePoint)return false;
  const point={...this.resumePoint};
  if(point.completed){this.cancel();this.callbacks.end({mode:point.completionMode});return true;}
  await this.send(point.message,point.mode,point);return true;
 }
 togglePause(){return this.paused?this.resume():this.pause();}
 clearCanvas(){this.resetSession();this.callbacks.clear?.();}
 async voice(turn,signal){
  await this.fish.ready;
  if(this.fish.config.configured&&this.fish.config.enabled){try{return await this.fish.speak(turn,signal);}catch(e){if(!signal.aborted)this.callbacks.notify('Fish Audio: '+e.message+'. Using the current fallback voice.');}}
  if(this.config.speechMode!=='api'){
   if((this.config.speechMode||'fish')==='fish'&&!this.fishFallbackNotified&&!(this.fish.config.configured&&this.fish.config.enabled)){this.fishFallbackNotified=true;this.callbacks.notify('Fish Audio 尚未配置，当前使用浏览器朗读。');}
   return null;
  }
  try{const r=await this.request('/api/speech',{text:turn.text,who:turn.who,emotion:turn.emotion},signal);return URL.createObjectURL(await r.blob());}
  catch(e){if(!signal.aborted)this.callbacks.notify('API voice unavailable: '+e.message+'. Using live browser speech.');return null;}
 }
 async send(message,mode='create',continuation=null){
  if(isClearCanvasRequest(message)){this.clearCanvas();return;}
  if(!this.config.configured){this.pending={message,mode};this.open();return;}
  this.cancel();const epoch=this.epoch;this.controller=new AbortController();const signal=this.controller.signal;this.running=true;this.fishFallbackNotified=false;$('#stop-live').hidden=false;$('#pause-meeting').disabled=false;this.currentMeeting={message,mode,brief:continuation?.brief,step:continuation?.step||0,who:continuation?.who||(mode==='final'?'chad':DESIGNER_ID)};this.callbacks.begin({mode,resuming:!!continuation});this.syncMeetingControl();
  if(!continuation){this.briefMessages=(this.briefMessages||[]).concat(message).slice(-8);this.history.push({who:'user',text:message});}
  const brief=continuation?.brief||this.briefMessages.join('\nUSER UPDATE: ');
  this.currentMeeting.brief=brief;
  if(this.expertiseReady){await this.expertiseReady;if(epoch!==this.epoch)return;if(!this.expertise){this.callbacks.notify('岗位技能暂时无法加载，请刷新页面后重试。');this.cancel();return;}}
  const queue=[],urls=new Set();let playing=false,producerDone=false,step=continuation?.step||0,who=continuation?.who||(mode==='final'?'chad':DESIGNER_ID),completionMode='paused';
  const drain=async()=>{
   if(playing)return;playing=true;
   try{while(queue.length&&epoch===this.epoch){
    const turn=queue.shift(),audioUrl=await turn.audioPromise;if(epoch!==this.epoch){turn.onRendered();break;}
    this.currentMeeting=turn.continuation;this.callbacks.apply(turn);this.history.push({who:turn.who,text:turn.text,subtitle:turn.cn,decision:turn.decision,changes:turn.changes,sources:turn.sources,reviewStatus:turn.reviewStatus});this.history=this.history.slice(-24);this.saveSession();
    this.speaking=true;turn.onRendered();await this.callbacks.say({...turn,id:'live-'+epoch+'-'+turn.step,live:true,audioUrl});this.speaking=false;
    if(audioUrl){URL.revokeObjectURL(audioUrl);urls.delete(audioUrl);}
   }}finally{playing=false;if(producerDone&&epoch===this.epoch&&!queue.length){this.running=false;this.currentMeeting=null;$('#stop-live').hidden=true;$('#pause-meeting').disabled=true;this.callbacks.end({mode:completionMode});this.syncMeetingControl();}}
  };
  try{
   while(epoch===this.epoch&&!signal.aborted){
    this.currentMeeting={message,mode,brief,step,who};
    this.callbacks.thinking({who,step:step+1,total:null});
    const design=this.callbacks.getDesign(),expert=expertContext(this.expertise,who,{design,history:this.history,userInstruction:message});
    const turn=await this.researchTurn({message:brief,professional:this.config.expertSkills?null:expert,mode:mode==='final'?'final':step===0?'create':'review',step,who,design,image:this.callbacks.getPosterImage(),history:this.history.slice(-24)},signal);if(epoch!==this.epoch)break;
    const nextWho=who===DESIGNER_ID?(mode==='final'?'chad':'rick'):who==='rick'?'chad':DESIGNER_ID;
    const finalReview=mode==='final'&&design.userDecision?.finalized,accepted=turn.who==='chad'&&turn.reviewStatus==='approved';
    turn.continuation={message,mode,brief,step:step+1,who:nextWho,completed:finalReview||accepted,completionMode:finalReview?'review_only':'final'};
    turn.text=turn.text.replace(/^(?:Trump|Doubao|CJ|Rick|June|Chad)\s*:\s*/i,'').replace(/\bRick\b/g,'Trump').replace(/\bJune\b/g,'Doubao').replace(/\bChad\b/g,'CJ');turn.cn=turn.cn.replace(/^(?:特朗普|川普|豆包|CJ|Trump|Doubao)\s*[：:]\s*/i,'').replace(/\bRick\b/g,'Trump').replace(/\bJune\b/g,'豆包').replace(/\bChad\b/g,'CJ');
    turn.audioPromise=this.voice(turn,signal).then(url=>{if(epoch!==this.epoch){if(url)URL.revokeObjectURL(url);return null;}if(url)urls.add(url);return url;});
    if(turn.interrupt&&this.speaking)turn.audioPromise.then(()=>{if(epoch===this.epoch&&this.speaking)this.callbacks.cutIn();});
    // The next agent sees the exact canvas that was actually rendered for this line.
    await new Promise(resolve=>{this.releaseRendered=resolve;turn.onRendered=resolve;queue.push(turn);drain();});
    step++;
    if(mode==='final'&&design.userDecision?.finalized){completionMode='review_only';break;}
    if(turn.who==='chad'&&turn.reviewStatus==='approved'){completionMode='final';break;}
    who=nextWho;
   }
  }catch(e){if(!signal.aborted)this.callbacks.notify('Meeting paused: '+e.message);}
  finally{producerDone=true;if(!playing&&epoch===this.epoch){this.running=false;this.currentMeeting=null;$('#stop-live').hidden=true;$('#pause-meeting').disabled=true;this.callbacks.end({mode:completionMode});this.syncMeetingControl();}if(epoch!==this.epoch)urls.forEach(url=>URL.revokeObjectURL(url));}
 }

}
