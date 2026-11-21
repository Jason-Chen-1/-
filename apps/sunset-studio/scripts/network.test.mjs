import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import {parseWindowsProxy,resolveProxyOptions,configureNetwork} from '../server/network.mjs';

const sameProxy=(value,expected)=>assert.equal(new URL(value).href,new URL(expected).href);
const noProxies=options=>{assert.ok(!options.httpProxy);assert.ok(!options.httpsProxy);};
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve(server.address().port);});});
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});
const restoreDispatcher=async original=>{const current=getGlobalDispatcher();setGlobalDispatcher(original);if(current!==original)await current.close();};

test('enabled Windows manual proxy supports one address and protocol-specific addresses',()=>{
 const single=parseWindowsProxy({ProxyEnable:1,ProxyServer:'127.0.0.1:7897'});
 sameProxy(single.httpProxy,'http://127.0.0.1:7897/');
 sameProxy(single.httpsProxy,'http://127.0.0.1:7897/');
 const split=parseWindowsProxy({ProxyEnable:1,ProxyServer:'http=127.0.0.1:7897;https=127.0.0.1:7898'});
 sameProxy(split.httpProxy,'http://127.0.0.1:7897/');
 sameProxy(split.httpsProxy,'http://127.0.0.1:7898/');
});

test('disabled, absent, and malformed Windows proxy settings leave requests direct',()=>{
 for(const settings of [
  {},
  {ProxyEnable:0,ProxyServer:'127.0.0.1:7897'},
  {ProxyEnable:1,ProxyServer:''},
  {ProxyEnable:1,ProxyServer:'not a proxy address'},
  {ProxyEnable:1,ProxyServer:'http://127.0.0.1:invalid'},
  {ProxyEnable:1,ProxyServer:'file:///tmp/proxy'},
 ])noProxies(parseWindowsProxy(settings));
});

test('explicit proxy environment wins over system settings and lowercase wins over uppercase',()=>{
 let systemReads=0;
 const options=resolveProxyOptions({
  env:{http_proxy:'http://127.0.0.1:8101',HTTP_PROXY:'http://127.0.0.1:8102',https_proxy:'http://127.0.0.1:8103',HTTPS_PROXY:'http://127.0.0.1:8104'},
  platform:'win32',
  readWindowsProxy:()=>{systemReads++;throw new Error('System proxy must not replace explicit configuration.');},
 });
 sameProxy(options.httpProxy,'http://127.0.0.1:8101/');
 sameProxy(options.httpsProxy,'http://127.0.0.1:8103/');
 assert.equal(systemReads,0);
});

test('Windows system proxy is discovered only when no explicit proxy is supplied',()=>{
 let systemReads=0;
 const options=resolveProxyOptions({env:{},platform:'win32',readWindowsProxy:()=>{systemReads++;return {ProxyEnable:1,ProxyServer:'127.0.0.1:7897'};}});
 sameProxy(options.httpProxy,'http://127.0.0.1:7897/');
 sameProxy(options.httpsProxy,'http://127.0.0.1:7897/');
 assert.equal(systemReads,1);
 const explicit=resolveProxyOptions({env:{HTTPS_PROXY:'http://127.0.0.1:8105'},platform:'win32',readWindowsProxy:()=>{systemReads++;throw new Error('Unexpected system read.');}});
 sameProxy(explicit.httpsProxy,'http://127.0.0.1:8105/');
 assert.equal(systemReads,1);
});

test('NO_PROXY preserves user exclusions and always includes local HTTP services',()=>{
 const options=resolveProxyOptions({env:{no_proxy:'.internal.example,custom.example:8443',NO_PROXY:'ignored.example'},platform:'linux'});
 const entries=options.noProxy.split(/[,\s]+/).filter(Boolean);
 for(const host of ['.internal.example','custom.example:8443','localhost','127.0.0.1','[::1]','::1'])assert.ok(entries.includes(host),`Missing bypass entry: ${host}`);
 assert.ok(!entries.includes('ignored.example'));
 const uppercase=resolveProxyOptions({env:{NO_PROXY:'uppercase.example'},platform:'linux'});
 assert.ok(uppercase.noProxy.split(/[,\s]+/).includes('uppercase.example'));
});

test('unavailable system proxy readers fail gracefully and direct mode keeps its dispatcher',()=>{
 for(const platform of ['win32','darwin']){
  const options=resolveProxyOptions({env:{},platform,readWindowsProxy:()=>{throw new Error('Registry unavailable.');},readMacProxy:()=>{throw new Error('System proxy unavailable.');}});
  noProxies(options);
 }
 const original=getGlobalDispatcher();
 assert.equal(configureNetwork({env:{},platform:'linux'}),false);
 assert.equal(getGlobalDispatcher(),original);
});

test('Node built-in fetch bypasses an unreachable proxy for local services',async()=>{
 const original=getGlobalDispatcher();
 const local=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.end('local service reached directly');});
 const port=await listen(local);
 try{
  assert.equal(configureNetwork({env:{HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'},platform:'linux'}),true);
  const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
  assert.equal(await response.text(),'local service reached directly');
 }finally{await restoreDispatcher(original);await close(local);}
});

test('Node built-in fetch uses the configured proxy for a nonlocal target without external traffic',async()=>{
 const original=getGlobalDispatcher();
 let proxyRequests=0;
 const sockets=new Set();
 const result='response supplied entirely by the local test proxy';
 const proxy=http.createServer((req,res)=>{proxyRequests++;res.writeHead(200,{'Content-Type':'text/plain','Connection':'close'});res.end(result);});
 proxy.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 proxy.on('connect',(req,socket)=>{
  proxyRequests++;
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  socket.once('data',()=>socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(result)}\r\nConnection: close\r\n\r\n${result}`));
 });
 const port=await listen(proxy);
 try{
  assert.equal(configureNetwork({env:{HTTP_PROXY:`http://127.0.0.1:${port}`},platform:'linux'}),true);
  const response=await fetch('http://network-regression.invalid/proxy-check',{signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
  assert.equal(await response.text(),result);
  assert.ok(proxyRequests>0);
 }finally{
  for(const socket of sockets)socket.destroy();
  await restoreDispatcher(original);
  await close(proxy);
 }
});
