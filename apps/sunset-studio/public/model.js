import {sanitizeArtboard} from './design-schema.js';
import {canEditDesign,isDesignAction} from './roles.js';
export {clearDesign} from './design-schema.js';
export const INITIAL = { title:'SUNSET SOCIAL',date:'SATURDAY / 6 PM TILL LATE',location:'VENICE BEACH, LOS ANGELES',brand:'SOL',palette:'sunset',layout:'bold',clutter:false,logoScale:1,revision:1,locked:false,approvals:{rick:false,june:false,chad:false} };
export const PALETTES = ['sunset','ocean','night','lime'];
export function fresh(){return structuredClone(INITIAL);}
export function cleanBrief(value,limit,fallback){return String(value??'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,limit)||fallback;}
export function restore(value){
 const s=fresh(); if(!value||typeof value!=='object')return s;
 const board=sanitizeArtboard(value.artboard);
 for(const [k,n] of [['title',35],['date',45],['location',45],['brand',12]])s[k]=board&&typeof value[k]==='string'&&!value[k].trim()?'':cleanBrief(value[k],n,s[k]);
 if(PALETTES.includes(value.palette))s.palette=value.palette;
 if(['bold','minimal'].includes(value.layout))s.layout=value.layout;
 if([1,2.8].includes(value.logoScale))s.logoScale=value.logoScale;
 s.revision=Number.isInteger(value.revision)?Math.max(1,Math.min(999,value.revision)):1;
 if(board)s.artboard=board;
 if(value.userDecision?.finalized===true&&value.userDecision.revision===s.revision){s.userDecision={finalized:true,revision:s.revision};s.locked=true;}
 return s;
}
export function parseInstruction(input){
 const raw=String(input).trim(); const text=raw.toLowerCase();
 if(isClearCanvasRequest(raw))return {kind:'clear'};
 if(/fight|argue|roast|吵|拱火/.test(text))return {kind:'fight'};
 if(/everybody stop|calm|quiet|够了|安静|别吵/.test(text))return {kind:'calm'};
 const title=raw.match(/^(?:title|headline|标题|名字)\s*[:：]\s*(.+)$/i);if(title)return {kind:'edit',patch:{title:cleanBrief(title[1],35,INITIAL.title)}};
 const date=raw.match(/^(?:date|when|日期|时间)\s*[:：]\s*(.+)$/i);if(date)return {kind:'edit',patch:{date:cleanBrief(date[1],45,INITIAL.date)}};
 const location=raw.match(/^(?:location|where|地点)\s*[:：]\s*(.+)$/i);if(location)return {kind:'edit',patch:{location:cleanBrief(location[1],45,INITIAL.location)}};
 if(/\b(don't|do not|never)\b|不要|别改/.test(text))return {kind:'unknown'};
 if(/blue|ocean|蓝|海蓝/.test(text))return {kind:'color',patch:{palette:'ocean'}};
 if(/purple|night|violet|紫/.test(text))return {kind:'color',patch:{palette:'night'}};
 if(/orange|warm|sunset|橙|暖/.test(text))return {kind:'color',patch:{palette:'sunset'}};
 if(/green|lime|绿/.test(text))return {kind:'color',patch:{palette:'lime'}};
 if(/smaller|less logo|缩小|小一点/.test(text))return {kind:'smaller'};
 if(/bigger|larger|big logo|放大|大一点/.test(text))return {kind:'bigger'};
 if(/minimal|simple|clean|简单|简洁/.test(text))return {kind:'minimal'};
 if(/receipt|you said|literally|原话|刚才/.test(text))return {kind:'receipt'};
 if(/two days|deadline|late|两天|延期/.test(text))return {kind:'deadline'};
 if(/extra|budget|money|cost|加钱|预算/.test(text))return {kind:'budget'};
 if(/\b(ship|done|export|approve)\b|交付|导出|完成/.test(text))return {kind:'ship'};
 if(/lock|confirm|锁定|确认/.test(text))return {kind:'lock'};
 if(/review|notes|feedback|评价|意见/.test(text))return {kind:'review'};
 return {kind:'unknown'};
}
export function isClearCanvasRequest(input){
 const text=String(input).trim().toLowerCase().replace(/[。！!？?，,；;.]+$/g,'').trim();
 if(/不要|别|不用|不许|不能|无需|\b(?:don't|do not|never)\b/.test(text))return false;
 if(/^(?:please\s+)?(?:clear|empty|erase|wipe)(?:\s+(?:all|the|my|current|entire))*\s*(?:canvas|poster|artboard|board|everything)?(?:\s+(?:completely|please))?$/.test(text))return true;
 const compact=text.replace(/\s+/g,'').replace(/(?:这个|这张|当前的?)/g,'').replace(/(?:给我|帮我|一下|谢谢)/g,'').replace(/画布上的?(?:所有)?(?:内容|东西|元素)/g,'画布');
 return /^(?:请|麻烦|现在|先|立刻)*(?:把|将)?(?:画布|海报|内容|所有元素|全部元素|全部内容|所有内容|所有东西)?(?:全部|全都|都)?(?:清空|清除|删掉|删除)(?:画布|海报|内容|所有元素|全部元素|全部内容|所有内容|所有东西|一切|全部|所有)?(?:干净)?$/.test(compact);
}
export function transition(previous,action,who='june'){
 const s=structuredClone(previous);
 if(s.userDecision?.finalized)return s;
 if(isDesignAction(action)){
  if(!canEditDesign(who))return s;
  s.approvals={rick:false,june:false,chad:false};
 }
 switch(action){
  case 'bigger':s.logoScale=2.8;s.locked=false;s.revision++;break;
  case 'balance':s.logoScale=1;s.clutter=false;s.approvals={rick:false,june:true,chad:false};s.revision++;break;
  case 'minimal':s.layout='minimal';s.logoScale=1;s.clutter=false;s.approvals={rick:false,june:true,chad:false};s.locked=false;s.revision++;break;
  case 'chaos':s.layout='bold';s.clutter=true;s.palette='night';s.revision++;break;
  case 'budgetCut':s.clutter=false;s.palette='sunset';s.revision++;break;
  case 'brandApproved':if(who==='june')s.approvals.june=true;break;
  case 'bossApproved':if(who==='rick')s.approvals.rick=true;break;
  case 'clientApproved':if(who==='chad')s.approvals.chad=true;break;
  case 'lock':s.locked=true;s.approvals.june=true;if(s.logoScale>1){s.logoScale=1;s.revision++;}break;
 }
 return s;
}
