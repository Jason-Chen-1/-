const loadImage=src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=src;});
export class StudioScene {
 constructor(container,onPerson){
  this.container=container;this.active=null;this.interrupter=null;this.heat=0;this.focus=null;this.amplitude=0;this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;this.mouse={x:0,y:0};this.loaded=false;
  this.canvas=document.createElement('canvas');this.canvas.setAttribute('aria-label','Fictional animated meeting: Trump, Doubao and CJ with audio-driven mouths, expressions and gestures.');container.append(this.canvas);this.ctx=this.canvas.getContext('2d');this.start=performance.now();this.last=0;
  this.people=['rick','june','chad'].map((id,i)=>({id,i,frame:0,talk:false,level:0,scale:1,x:0,y:0,size:0,phase:i*2.1}));
  Promise.all([loadImage('assets/art/studio.webp'),...this.people.map(p=>loadImage(`assets/characters/${p.id}-cast.webp`))]).then(([room,...images])=>{this.room=room;this.people.forEach((p,i)=>p.image=images[i]);this.loaded=true;}).catch(()=>{document.querySelector('#scene-error').hidden=false;});
  container.addEventListener('pointermove',e=>{const r=container.getBoundingClientRect();this.mouse.x=(e.clientX-r.left)/r.width-.5;this.mouse.y=(e.clientY-r.top)/r.height-.5;});
  this.canvas.addEventListener('click',e=>{const r=this.canvas.getBoundingClientRect();const x=e.clientX-r.left,y=e.clientY-r.top;const matches=this.people.filter(p=>x>p.x-p.size*.4&&x<p.x+p.size*.4&&y>p.y-p.size*.8&&y<p.y);const person=matches.sort((a,b)=>Math.abs(a.x-x)-Math.abs(b.x-x))[0];if(person)onPerson?.(person.id);});
  this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();requestAnimationFrame(t=>this.animate(t));
 }
 resize(){const r=this.container.getBoundingClientRect();this.w=r.width;this.h=r.height;this.dpr=Math.min(devicePixelRatio,2);this.canvas.width=Math.round(this.w*this.dpr);this.canvas.height=Math.round(this.h*this.dpr);this.canvas.style.width=this.w+'px';this.canvas.style.height=this.h+'px';this.people.forEach(p=>p.x=0);}
 setActive(id){this.active=id;}
 setReviewing(id){this.reviewing=id;}
 setInterjection(id){this.interrupter=id;}
 setHeat(n){this.heat=n;}
 setAmplitude(n){this.amplitude=n;}
 setFocus(id){this.focus=this.focus===id?null:id;}
 drawCover(img,x,y,w,h){const scale=Math.max(w/img.width,h/img.height);const dw=img.width*scale,dh=img.height*scale;this.ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);}
 animate(now){
  requestAnimationFrame(t=>this.animate(t));if(now-this.last<32)return;this.last=now;
  const c=this.ctx,w=this.w,h=this.h,t=(now-this.start)/1000;if(!w||!h)return;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.clearRect(0,0,w,h);
  if(!this.loaded){c.fillStyle='#372d28';c.fillRect(0,0,w,h);c.fillStyle='#e0b884';c.textAlign='center';c.font='14px Arial';c.fillText('Setting the scene…',w/2,h/2);return;}
  this.drawCover(this.room,-4,-3,w+8,h+6);
  const shade=c.createLinearGradient(0,0,0,h);shade.addColorStop(0,'#17181450');shade.addColorStop(.4,'#20201b08');shade.addColorStop(1,'#17110a55');c.fillStyle=shade;c.fillRect(0,0,w,h);
  const baseline=h*.91;let baseSize=Math.min(w*(w<700?.59:.37),h*.84);
  for(const p of this.people){
   const speaking=p.id===this.active||p.id===this.interrupter;const target=speaking?1.055:1;p.scale+=(target-p.scale)*.09;
   const focusScale=this.focus?(this.focus===p.id?1.28:.78):1;
   const pos=this.focus?(this.focus===p.id?.5:p.i< this.people.find(q=>q.id===this.focus).i?.08:.92):[.19,.5,.81][p.i];
   const targetX=w*pos+(this.reduced?0:this.mouse.x*(p.i+1)*2);
   p.x=p.x?p.x+(targetX-p.x)*.09:targetX;
   p.size=baseSize*p.scale*focusScale;p.y=baseline+(p.i===1?-h*.035:0)+(this.reduced?0:Math.sin(t*.9+p.phase)*1.3);
   p.level+=( (speaking?this.amplitude:0)-p.level)*.45;
   // Authored expression poses change at conversational, not strobing, speed.
   let pose=0;
   if(speaking)pose=(this.heat>50&&Math.sin(t*.8+p.phase)>.15)||Math.sin(t*.72+p.phase)>.91?2:1;
   else if(p.id===this.reviewing)pose=5;
   else if(this.active)pose=Math.sin(t*.5+p.phase)>.2?3:5;
   p.frame=pose;
  }
  const people=[...this.people].sort((a,b)=>(a.id===this.focus?1:0)-(b.id===this.focus?1:0));
  for(const p of people){
   c.save();if(w<700){c.beginPath();c.rect(w*p.i/3,0,w/3,h);c.clip();}c.translate(p.x,p.y);c.rotate(this.reduced?0:Math.sin(t*.55+p.phase)*.004);
   if(this.active&&this.active!==p.id&&this.interrupter!==p.id)c.filter='brightness(.85) saturate(.85)';
   const cw=p.image.width/3,ch=p.image.height/2,px=(p.frame%3)*cw,py=Math.floor(p.frame/3)*ch;
   c.drawImage(p.image,px+2,py+2,cw-4,ch-4,-p.size/2,-p.size,p.size,p.size);
   // Blend registered photographed mouth shapes to the live audio envelope.
   if(p.id===this.active||p.id===this.interrupter){
    const maps={rick:[[.52,.352],[.521,.356],[.524,.367],[.522,.341],[.529,.375],[.522,.351]],chad:[[.51,.288],[.515,.285],[.506,.302],[.511,.282],[.501,.311],[.506,.283]],june:[[.518,.384],[.511,.383],[.518,.395],[.514,.382],[.52,.391],[.522,.374]]};
    const map=maps[p.id],mouth=p.level<.10?0:p.level<.32?1:p.level>.7?2:Math.sin(t*15+p.phase)>.5?4:1;
    if(!p.mouthCanvas){p.mouthCanvas=document.createElement('canvas');p.mouthCanvas.width=160;p.mouthCanvas.height=110;p.mouthContext=p.mouthCanvas.getContext('2d');}
    const m=p.mouthContext,point=map[mouth],dest=map[p.frame],mw=p.id==='june'?.18:.21,mh=.145;
    m.clearRect(0,0,160,110);m.globalCompositeOperation='source-over';
    m.drawImage(p.image,(mouth%3)*cw+(point[0]-mw/2)*cw,Math.floor(mouth/3)*ch+(point[1]-mh/2)*ch,mw*cw,mh*ch,0,0,160,110);
    m.globalCompositeOperation='destination-in';m.save();m.translate(80,55);m.scale(80,55);const mask=m.createRadialGradient(0,0,.58,0,0,1);mask.addColorStop(0,'#fff');mask.addColorStop(1,'#fff0');m.fillStyle=mask;m.fillRect(-1,-1,2,2);m.restore();
    c.drawImage(p.mouthCanvas,(dest[0]-.5-mw/2)*p.size,(dest[1]-1-mh/2)*p.size,mw*p.size,mh*p.size);
   }
   c.restore();
  }
  // Re-render only the table strip in front, placing the cast behind the same table.
  c.save();c.beginPath();c.rect(0,h*.88,w,h*.12);c.clip();this.drawCover(this.room,-4,-3,w+8,h+6);c.restore();
  const floor=c.createLinearGradient(0,h*.84,0,h);floor.addColorStop(0,'#201a1300');floor.addColorStop(1,'#171710bb');c.fillStyle=floor;c.fillRect(0,h*.84,w,h*.16);
 }
}
