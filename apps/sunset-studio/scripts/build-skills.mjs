import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sources=JSON.parse(await fs.readFile(path.join(root,'skills/sources.json'),'utf8'));
const specs={june:['poster-designer','海报设计专家','anthropic-canvas-design'],rick:['delivery-supervisor','交付监督专家','agency-project-shepherd'],chad:['client-reviewer','客户评审专家','agency-reality-checker']};
const roles={};
for(const [who,[id,title,sourceId]] of Object.entries(specs)){
 const file=path.join(root,'skills/roles',id,'SKILL.md');
 const text=await fs.readFile(file,'utf8');
 const instructions=text.match(/<!-- runtime:start -->([\s\S]*?)<!-- runtime:end -->/)?.[1]?.trim();
 if(!instructions||instructions.length>7000)throw new Error('Invalid reviewed runtime instructions for '+id);
 if(!sources.sources.some(source=>source.id===sourceId))throw new Error('Missing source attribution for '+id);
 roles[who]={id,title,sourceId,instructions,digest:createHash('sha256').update(instructions).digest('hex')};
}
const bundle={version:1,reviewedOn:sources.reviewedOn,roles,sources:sources.sources.map(({id,url,license,commit})=>({id,url,license,commit}))};
await fs.writeFile(path.join(root,'public/expertise.json'),JSON.stringify(bundle,null,2)+'\n');
console.log('Built 3 reviewed role skills for browser and server requests.');
