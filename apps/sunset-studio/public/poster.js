const themes={sunset:{top:'#eb9365',bottom:'#d97051',sun:'#f7c86c',sea:'#405b53',paper:'#f4dfb4',ink:'#283a32'},ocean:{top:'#81b8bc',bottom:'#477a91',sun:'#f1bf74',sea:'#254b56',paper:'#e5e1ba',ink:'#243f48'},night:{top:'#b09ba8',bottom:'#795c86',sun:'#e2a06b',sea:'#393347',paper:'#e4d8b9',ink:'#343040'},lime:{top:'#b7bc8a',bottom:'#8f9e76',sun:'#f4cf76',sea:'#3f6150',paper:'#f0e6be',ink:'#2d4334'}};
export function drawPoster(canvas,state,highlight=''){
 if(Array.isArray(state.artboard?.elements)){drawArtboard(canvas,state.artboard);return;}
 const x=canvas.getContext('2d');const W=1080,H=1350;const p=themes[state.palette]||themes.sunset;
 x.clearRect(0,0,W,H);x.fillStyle=p.paper;x.fillRect(0,0,W,H);x.save();x.beginPath();x.rect(28,28,W-56,H-56);x.clip();
 const g=x.createLinearGradient(0,0,0,H);g.addColorStop(0,p.top);g.addColorStop(1,p.bottom);x.fillStyle=g;x.fillRect(28,28,W-56,H-56);
 x.strokeStyle=p.ink;x.lineWidth=3;x.strokeRect(52,52,W-104,H-104);
 x.fillStyle=p.ink;x.font='600 22px "DM Sans", Arial';x.textAlign='left';x.letterSpacing='4px';x.fillText('A LITTLE SUN. A LITTLE TROUBLE.',83,108);x.letterSpacing='0px';
 // Hand-drawn coastal landscape.
 x.fillStyle=p.sun;x.beginPath();x.arc(690,725,state.layout==='minimal'?205:245,0,Math.PI*2);x.fill();
 x.save();x.beginPath();x.arc(690,725,state.layout==='minimal'?205:245,0,Math.PI*2);x.clip();
 for(let i=0;i<8;i++){x.fillStyle=p.bottom;x.fillRect(400,800+i*24,600,5+i*1.8);}x.restore();
 x.fillStyle=p.sea;x.beginPath();x.moveTo(0,1000);x.bezierCurveTo(300,920,600,1060,1080,940);x.lineTo(1080,H);x.lineTo(0,H);x.fill();
 x.strokeStyle=p.paper;x.globalAlpha=.28;x.lineWidth=2;for(let i=0;i<7;i++){x.beginPath();x.moveTo(50,1015+i*19);x.bezierCurveTo(290,990+i*19,700,1040+i*19,1020,990+i*19);x.stroke();}x.globalAlpha=1;
 function palm(px,py,s,lean){x.save();x.translate(px,py);x.scale(s,s);x.strokeStyle=p.ink;x.lineCap='round';x.lineWidth=15;x.beginPath();x.moveTo(-25,330);x.quadraticCurveTo(-15,180,lean,0);x.stroke();x.translate(lean,0);for(let i=0;i<8;i++){x.save();x.rotate(i*Math.PI/4+.3);x.beginPath();x.moveTo(0,0);x.quadraticCurveTo(70,-58,145,40);x.quadraticCurveTo(65,-3,0,0);x.fillStyle=p.ink;x.fill();x.restore();}x.restore();}
 palm(220,665,1.05,30);if(state.layout==='bold')palm(990,710,.85,-30);
 // Large editorial title fitted to user input.
 x.fillStyle=p.ink;x.textAlign='left';const words=state.title.toUpperCase().split(/\s+/);let lines=[];
 if(words.length===1)lines=[words[0]];else {let split=Math.ceil(words.length/2);lines=[words.slice(0,split).join(' '),words.slice(split).join(' ')];}
 if(state.title.length>24&&words.length>3){lines=[];let line='';for(const word of words){if((line+' '+word).length>15&&line){lines.push(line);line=word;}else line+=(line?' ':'')+word;}if(line)lines.push(line);lines=lines.slice(0,3);}
 let font=lines.length>2?144:196;for(const line of lines){x.font=`800 ${font}px "Barlow Condensed", Impact, sans-serif`;while(x.measureText(line).width>910&&font>60){font--;x.font=`800 ${font}px "Barlow Condensed", Impact, sans-serif`;}}
 x.textBaseline='alphabetic';lines.forEach((line,i)=>{x.font=`800 ${font}px "Barlow Condensed", Impact, sans-serif`;x.fillText(line,80,295+i*font*.88);});
 if(state.layout==='bold'){
  x.save();x.translate(825,570);x.rotate(-.13);x.fillStyle=p.paper;x.fillRect(-118,-34,235,68);x.strokeStyle=p.ink;x.lineWidth=2;x.strokeRect(-118,-34,235,68);x.fillStyle=p.ink;x.font='700 25px "DM Sans",Arial';x.textAlign='center';x.fillText('NO BAD DAYS*',0,8);x.restore();
  x.font='500 19px "DM Sans",Arial';x.textAlign='left';x.fillStyle=p.ink;x.fillText('*EXCEPT REVISION DAYS.',80,550);
 }
 x.fillStyle=p.paper;x.textAlign='center';x.font='700 38px "Barlow Condensed",Impact';fitText(x,state.date.toUpperCase(),540,1192,920,38,'"Barlow Condensed",Impact',700);
 x.font='500 21px "DM Sans",Arial';fitText(x,state.location.toUpperCase(),540,1237,910,21,'"DM Sans",Arial',500);
 x.font='500 15px "DM Sans",Arial';x.fillText('GOOD PEOPLE / GOOD MUSIC / ONE LAST SUNSET',540,1281);
 // The intentionally oversized client logo collides with the date.
 const big=state.logoScale>1;const bx=big?560:906,by=big?1065:171,br=big?257:73;
 x.save();x.translate(bx,by);x.rotate(big?-.08:.08);x.fillStyle=p.paper;x.beginPath();x.arc(0,0,br,0,Math.PI*2);x.fill();x.strokeStyle=p.ink;x.lineWidth=big?5:2;x.beginPath();x.arc(0,0,br-9,0,Math.PI*2);x.stroke();x.fillStyle=p.ink;x.textAlign='center';x.font=`800 ${big?160:52}px "Barlow Condensed",Impact`;fitText(x,state.brand.toUpperCase(),0,big?42:16,br*1.6,big?160:52,'"Barlow Condensed",Impact',800);x.restore();
 if(state.clutter){
  const stickers=[['MORE VIBES',265,580,-.16],['VIP ENERGY',760,820,.12],['BRING YOUR DOG',480,1050,-.08]];
  for(const [text,px,py,angle] of stickers){x.save();x.translate(px,py);x.rotate(angle);x.fillStyle='#ecca68';x.fillRect(-185,-47,370,94);x.strokeStyle=p.ink;x.lineWidth=4;x.strokeRect(-185,-47,370,94);x.fillStyle=p.ink;x.textAlign='center';x.font='800 40px "Barlow Condensed",Impact';x.fillText(text,0,15);x.restore();}
 }
 if(highlight){x.save();x.strokeStyle='#fff8df';x.setLineDash([13,10]);x.lineWidth=6;if(highlight==='date')x.strokeRect(65,1140,950,119);if(highlight==='logo'){x.beginPath();x.arc(bx,by,br+13,0,Math.PI*2);x.stroke();}x.restore();}
 // Fine deterministic paper grain, safe for a clean downloadable PNG.
 x.globalAlpha=.06;for(let i=0;i<1900;i++){const px=(Math.sin(i*127.1)*43758.5453)%1;const py=(Math.sin(i*311.7)*96321.341)%1;x.fillStyle=i%2?'#fff':'#000';x.fillRect(Math.abs(px)*W,Math.abs(py)*H,1.5,1.5);}x.globalAlpha=1;x.restore();
}
function fitText(x,text,px,py,width,size,family,weight){x.font=`${weight} ${size}px ${family}`;while(x.measureText(text).width>width&&size>9){size--;x.font=`${weight} ${size}px ${family}`;}x.fillText(text,px,py);}
function drawArtboard(canvas,board){
 const c=canvas.getContext('2d');c.clearRect(0,0,1080,1350);c.fillStyle=board.background;
 if(board.gradient){const gradient=c.createLinearGradient(0,0,0,1350);gradient.addColorStop(0,board.background);gradient.addColorStop(1,board.gradient);c.fillStyle=gradient;}c.fillRect(0,0,1080,1350);
 for(const e of board.elements){c.save();c.globalAlpha=e.opacity??1;c.translate(e.x||0,e.y||0);c.rotate((e.rotate||0)*Math.PI/180);c.fillStyle=e.fill||e.color||'#152b27';c.strokeStyle=e.stroke||'transparent';c.lineWidth=e.strokeWidth||0;
  try{
   if(e.type==='text'){const fonts={sans:'"DM Sans",Arial,sans-serif',condensed:'"Barlow Condensed",Impact,sans-serif',serif:'Georgia,serif'};c.fillStyle=e.color||e.fill||'#172b26';c.font=`${e.weight||700} ${e.size||60}px ${fonts[e.font]||fonts.condensed}`;c.textAlign=e.align||'left';c.textBaseline='top';String(e.text||'').replace(/\\n/g,'\n').split('\n').forEach((line,i)=>c.fillText(line,0,i*(e.size||60)*(e.lineHeight||1.05),e.w||1000));}
   else if(e.type==='path'){const p=new Path2D(e.path||'');if(e.fill!=='transparent')c.fill(p);if(e.strokeWidth)c.stroke(p);}
   else {c.beginPath();if(e.type==='rect')c.roundRect(0,0,e.w,e.h,Math.min(e.r||0,e.w/2,e.h/2));if(e.type==='ellipse')c.ellipse(e.w/2,e.h/2,e.w/2,e.h/2,0,0,Math.PI*2);if(e.type==='line'){c.moveTo(0,0);c.lineTo(e.w,e.h);}if(e.type!=='line'&&e.fill!=='transparent')c.fill();if(e.strokeWidth)c.stroke();}
  }catch{}c.restore();
 }
}
