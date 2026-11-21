import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {EnvHttpProxyAgent,setGlobalDispatcher} from 'undici';

function proxyAddress(raw){
 const text=String(raw||'').trim();if(!text)return undefined;
 try{
  const url=new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text)?text:'http://'+text);
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.pathname!=='/'||url.search||url.hash)return undefined;
  return url.href;
 }catch{return undefined;}
}

export function parseWindowsProxy(settings={}){
 if(Number(settings.ProxyEnable)!==1)return {};
 const server=String(settings.ProxyServer||'').trim();if(!server)return {};
 if(!server.includes('=')){const address=proxyAddress(server);return address?{httpProxy:address,httpsProxy:address}:{};}
 const result={};
 for(const entry of server.split(';')){
  const match=entry.trim().match(/^(http|https)\s*=\s*(.+)$/i);if(!match)continue;
  const address=proxyAddress(match[2]);if(address)result[match[1].toLowerCase()+'Proxy']=address;
 }
 return result;
}

function readWindowsProxy(){
 const command="$settings=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop; [pscustomobject]@{ProxyEnable=$settings.ProxyEnable;ProxyServer=$settings.ProxyServer}|ConvertTo-Json -Compress";
 return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:3000,windowsHide:true,stdio:['ignore','pipe','ignore']}));
}

function readMacProxy(){
 const system=execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']});
 const value=name=>system.match(new RegExp('(?:^|\\n)\\s*'+name+' : ([^\\n]+)'))?.[1]?.trim();
 const result={};
 for(const [prefix,key]of [['HTTP','httpProxy'],['HTTPS','httpsProxy']]){
  if(value(prefix+'Enable')==='1'&&value(prefix+'Proxy')&&/^\d+$/.test(value(prefix+'Port')||'')){
   const address=proxyAddress(value(prefix+'Proxy')+':'+value(prefix+'Port'));if(address)result[key]=address;
  }
 }
 return result;
}

export function resolveProxyOptions({env=process.env,platform=process.platform,readWindowsProxy:readWindows=readWindowsProxy,readMacProxy:readMac=readMacProxy}={}){
 const explicitHttp=env.http_proxy||env.HTTP_PROXY,explicitHttps=env.https_proxy||env.HTTPS_PROXY;
 let proxies={};
 if(explicitHttp||explicitHttps){
  for(const [value,key]of [[explicitHttp,'httpProxy'],[explicitHttps,'httpsProxy']]){
   if(value){const address=proxyAddress(value);if(!address)throw new Error('代理地址无效，请将 HTTP_PROXY / HTTPS_PROXY 设置为有效的 HTTP 或 HTTPS 代理地址。');proxies[key]=address;}
  }
 }else{
  try{if(platform==='win32')proxies=parseWindowsProxy(readWindows());else if(platform==='darwin')proxies=readMac();}catch{}
 }
 const existing=String(env.no_proxy||env.NO_PROXY||'').split(/[,\s]+/).filter(Boolean);
 const noProxy=existing.includes('*')?'*':[...new Set([...existing,'localhost','127.0.0.1','[::1]','::1'])].join(',');
 return {...proxies,noProxy};
}

// Native support is absent on Node 22.18; Undici also configures built-in fetch.
export function configureNetwork(options={}){
 const proxies=resolveProxyOptions(options);if(!proxies.httpProxy&&!proxies.httpsProxy)return false;
 if(typeof http.setGlobalProxyFromEnv==='function'){
  http.setGlobalProxyFromEnv({HTTP_PROXY:proxies.httpProxy||'',HTTPS_PROXY:proxies.httpsProxy||'',NO_PROXY:proxies.noProxy});
 }else{
  setGlobalDispatcher(new EnvHttpProxyAgent({...proxies,httpProxy:proxies.httpProxy||'',httpsProxy:proxies.httpsProxy||''}));
 }
 return true;
}

export {requestErrorMessage} from './network-errors.mjs';
