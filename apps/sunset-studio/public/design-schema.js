const num=(v,f,min=-3000,max=4000)=>Number.isFinite(Number(v))?Math.min(max,Math.max(min,Number(v))):f;
const color=(v,f)=>typeof v==='string'&&/^(#[0-9a-f]{3,8}|transparent)$/i.test(v)?v:f;
export function sanitizeArtboard(value){
 if(!value||!Array.isArray(value.elements))return null;
 const elements=value.elements.slice(0,90).filter(e=>e&&['text','rect','ellipse','path','line'].includes(e.type)).map((e,i)=>({
  id:String(e.id||'element-'+i).slice(0,60),type:e.type,x:num(e.x,0),y:num(e.y,0),w:num(e.w,e.type==='text'?900:100,0,3000),h:num(e.h,100,0,3000),r:num(e.r,0,0,500),
  color:color(e.color,'#172b26'),fill:color(e.fill,e.type==='line'?'transparent':'#172b26'),stroke:color(e.stroke,'transparent'),strokeWidth:num(e.strokeWidth,0,0,50),
  opacity:num(e.opacity,1,0,1),rotate:num(e.rotate,0,-360,360),text:String(e.text??'').slice(0,300),size:num(e.size,60,8,350),
  weight:[400,500,600,700,800,900].includes(Number(e.weight))?Number(e.weight):700,font:['sans','serif','condensed'].includes(e.font)?e.font:'condensed',
  align:['left','center','right'].includes(e.align)?e.align:'left',lineHeight:num(e.lineHeight,1.05,.6,2),path:typeof e.path==='string'?e.path.slice(0,12000):''
 }));
 return {background:color(value.background,'#ead0a0'),gradient:color(value.gradient,null),elements};
}
export function clearDesign(current){
 const next=structuredClone(current);
 Object.assign(next,{title:'',date:'',location:'',brand:'',artboard:{background:'#ffffff',gradient:null,elements:[]},revision:(Number(next.revision)||1)+1,locked:false,clutter:false,approvals:{rick:false,june:false,chad:false}});
 delete next.userDecision;
 next.clientReview={status:'pending',feedback:'画布已清空，等待你的新要求。',revision:next.revision};
 return next;
}
export function applyDesignEdit(current,edit){
 const next=structuredClone(current);let changed=false;
 if(!edit||typeof edit!=='object')return {design:next,changed};
 if(edit.clear===true)return {design:clearDesign(current),changed:true};
 for(const [k,max] of [['title',35],['date',45],['location',45],['brand',12]])if(typeof edit[k]==='string'&&edit[k].trim()){next[k]=edit[k].trim().slice(0,max);changed=true;}
 if(['sunset','ocean','night','lime'].includes(edit.palette)){next.palette=edit.palette;changed=true;}
 if(['bold','minimal'].includes(edit.layout)){next.layout=edit.layout;changed=true;}
 if([1,2.8].includes(edit.logoScale)){next.logoScale=edit.logoScale;changed=true;}
 if(edit.artboard){const board=sanitizeArtboard(edit.artboard);if(board){next.artboard=board;changed=true;}}
 if(next.artboard&&(Array.isArray(edit.upsert)||Array.isArray(edit.remove)||edit.background)){
  let board=structuredClone(next.artboard);const removed=new Set((edit.remove||[]).map(String));board.elements=board.elements.filter(e=>!removed.has(e.id));
  for(const e of (edit.upsert||[]).slice(0,30)){const index=board.elements.findIndex(old=>old.id===e.id);if(index>=0)board.elements[index]={...board.elements[index],...e};else board.elements.push(e);}
  if(edit.background)board.background=edit.background;next.artboard=sanitizeArtboard(board);changed=true;
 }
 if(changed){next.revision=(Number(next.revision)||1)+1;next.locked=false;next.approvals={rick:false,june:false,chad:false};}
 return {design:next,changed};
}
