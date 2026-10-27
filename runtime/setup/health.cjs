'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');

const PUBLIC_CACHE_MS = 5 * 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
}
async function readJson(filename) {
  try {
    if((await fs.stat(filename)).size>65536)return {invalid:true};
    const value=JSON.parse(await fs.readFile(filename,'utf8'));
    return value&&typeof value==='object'&&!Array.isArray(value)?{value}:{invalid:true};
  }catch(error){return error.code==='ENOENT'?{missing:true}:{invalid:true};}
}
function publicBase(value) {
  try {
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&url.pathname==='/'&&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ngrok-free\.(?:app|dev)$/.test(url.hostname)?url.origin:null;
  }catch{return null;}
}
function pipeGreeting(address) {
  return new Promise(resolve=>{
    const socket=net.connect(address);let text='',done=false;
    const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};
    socket.setEncoding('utf8');socket.setTimeout(1000,()=>finish(null));
    socket.on('error',()=>finish(null));socket.on('end',()=>finish(null));
    socket.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>4096)return finish(null);if(text.includes('\n')){try{finish(JSON.parse(text.slice(0,text.indexOf('\n'))));}catch{finish(null);}}});
  });
}
function loopbackUrl(value, expectedPath) {
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!==expectedPath)throw new Error('Use a fixed loopback health endpoint.');
  return url;
}
// Exposed for isolated HTTP fixtures; production uses only the fixed loopback routes.
function createPassiveProbes({managerPipe='\\\\.\\pipe\\BackgroundBrowserMCP-manager-v1',loginPipe='\\\\.\\pipe\\BackgroundBrowserMCP-login-v1',urls={}}={}) {
  const cdp=loopbackUrl(urls.cdp||'http://127.0.0.1:8935/json/version','/json/version');
  const mcp=loopbackUrl(urls.mcp||'http://127.0.0.1:8933/mcp','/mcp');
  const gateway=loopbackUrl(urls.gateway||'http://127.0.0.1:8934/health','/health');
  async function jsonProbe(url, validate, external=false) {
    try {
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(1500),headers:external?{'ngrok-skip-browser-warning':'1'}:{}});
      if(!response.ok){await response.body?.cancel();return false;}
      const reader=response.body?.getReader();const chunks=[];let size=0;
      try{if(reader)while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536){await reader.cancel();return null;}chunks.push(Buffer.from(next.value));}}
      finally{reader?.releaseLock();}
      const text=Buffer.concat(chunks).toString('utf8');
      try{return validate(JSON.parse(text))?true:null;}catch{return null;}
    }catch{return false;}
  }
  const gatewayShape=value=>value?.ok===true&&value.authenticatedBrowserGateway===true;
  return {
    manager:()=>pipeGreeting(managerPipe),login:()=>pipeGreeting(loginPipe),
    cdp:()=>jsonProbe(cdp,value=>{
      if(typeof value?.Browser!=='string'||typeof value['Protocol-Version']!=='string')return false;
      try{const ws=new URL(value.webSocketDebuggerUrl);return ws.protocol==='ws:'&&ws.hostname==='127.0.0.1'&&ws.port===cdp.port&&!ws.username&&!ws.password&&!ws.search&&!ws.hash&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(ws.pathname);}catch{return false;}
    }),
    // HEAD cannot initialize an MCP session or open the GET/SSE stream.
    mcp:async()=>{try{const response=await fetch(mcp,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(1500),headers:{Accept:'application/json'}});await response.body?.cancel();return [400,405,406].includes(response.status)?true:response.status===404||response.status>=500?false:null;}catch{return false;}},
    gateway:()=>jsonProbe(gateway,gatewayShape),
    publicHealth:base=>{const safe=publicBase(base);return safe?jsonProbe(safe+'/health',gatewayShape,true):Promise.resolve(null);}
  };
}
function debounce() {
  let stable='checking',candidate=null,count=0;
  return {
    reset(){stable='checking';candidate=null;count=0;},
    sample(value){
      if(value!==true&&value!==false){candidate=null;count=0;return 'checking';}
      const state=value?'online':'offline';
      if(state===stable){candidate=null;count=0;return stable;}
      count=candidate===state?count+1:1;candidate=state;
      if(count>=(value?2:3)){stable=state;candidate=null;count=0;return stable;}
      return 'checking';
    }
  };
}
function createDashboardHealth({root,managerPipe,loginPipe,now=Date.now,probes={}}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root)||typeof now!=='function')throw new Error('A local runtime root and clock are required.');
  const probe={...createPassiveProbes({managerPipe,loginPipe}),...probes};
  const localDebounce=debounce(),remoteDebounce=debounce();
  let cached,cachedAt=-Infinity,pending,publicResult,publicAt=-Infinity,publicOrigin;
  const safely=async operation=>{try{return {known:true,value:await operation()};}catch{return {known:false};}};
  const component=(state,detailCode)=>({state,detailCode});
  const status=(mode,messageCode,local,remote,waitingForOwner=false)=>({version:1,checkedAt:new Date(now()).toISOString(),mode,messageCode,local,remote,waitingForOwner});
  async function sample() {
    const [policy,service,marker,config]=await Promise.all([
      readJson(path.join(root,'availability-config.json')),readJson(path.join(root,'service-state.json')),
      readJson(path.join(root,'login.pause')),readJson(path.join(root,'gateway','config.json'))
    ]);
    if(policy.value?.enabled===false){localDebounce.reset();remoteDebounce.reset();return status('stopped','BROWSER_STOPPED',component('stopped','INTENTIONAL_STOP'),component('stopped','INTENTIONAL_STOP'));}
    if(policy.value?.enabled!==true)return status('checking','POLICY_UNAVAILABLE',component('checking','POLICY_UNAVAILABLE'),component('checking','POLICY_UNAVAILABLE'));
    const owner=marker.value;
    if(Number.isSafeInteger(owner?.pid)&&owner.pid>0&&typeof owner.token==='string'&&owner.token.length>0&&owner.token.length<=128){
      const greeting=await safely(probe.login);
      if(greeting.known&&greeting.value?.pid===owner.pid&&same(greeting.value.token,owner.token)){
        localDebounce.reset();remoteDebounce.reset();return status('paused','SIGN_IN_IN_PROGRESS',component('paused','LIVE_SIGN_IN'),component('paused','LIVE_SIGN_IN'),true);
      }
    }
    const origin=config.value?publicBase(config.value.publicBaseUrl):null;
    const configured=Boolean(origin);
    const [manager,cdp,mcp,gateway]=await Promise.all([safely(probe.manager),safely(probe.cdp),safely(probe.mcp),configured?safely(probe.gateway):Promise.resolve({known:true,value:null})]);
    let localRaw=true,localDetail='LOCAL_READY';
    if(!manager.known){localRaw=null;localDetail='MANAGER_UNVERIFIED';}
    else if(!manager.value){localRaw=false;localDetail='MANAGER_UNREACHABLE';}
    else if(!service.value){localRaw=null;localDetail='SERVICE_STATE_UNAVAILABLE';}
    else if(!Number.isSafeInteger(manager.value.pid)||manager.value.pid<1||manager.value.pid!==service.value.managerPid||
      (typeof service.value.managerToken==='string'&&!same(manager.value.token,service.value.managerToken))||
      service.value.ready!==true||service.value.status!=='running'||service.value.headless!==true){localRaw=false;localDetail='MANAGER_NOT_READY';}
    else if(!cdp.known||cdp.value===null){localRaw=null;localDetail='CDP_UNVERIFIED';}
    else if(cdp.value!==true){localRaw=false;localDetail='CDP_UNREACHABLE';}
    else if(!mcp.known||mcp.value===null){localRaw=null;localDetail='MCP_UNVERIFIED';}
    else if(mcp.value!==true){localRaw=false;localDetail='MCP_UNREACHABLE';}
    const local=component(localDebounce.sample(localRaw),localDetail);
    let remote;
    if(config.missing){remoteDebounce.reset();remote=component('unconfigured','REMOTE_NOT_CONFIGURED');}
    else if(!configured){remoteDebounce.reset();remote=component('checking','REMOTE_CONFIG_UNAVAILABLE');}
    else {
      let raw,detail;
      if(!gateway.known||gateway.value===null){raw=null;detail='GATEWAY_UNVERIFIED';}
      else if(gateway.value!==true){raw=false;detail='GATEWAY_UNREACHABLE';}
      else {
        let age=now()-publicAt;
        if(age<0){publicAt=now();age=0;}
        if(origin!==publicOrigin||age>=PUBLIC_CACHE_MS){
          publicOrigin=origin;publicAt=now();publicResult=await safely(()=>probe.publicHealth(origin));
        }
        raw=publicResult?.known?publicResult.value:null;
        detail=raw===true?'REMOTE_READY':raw===false?'PUBLIC_HEALTH_UNREACHABLE':'PUBLIC_HEALTH_UNVERIFIED';
      }
      remote=component(remoteDebounce.sample(raw),detail);
    }
    if(local.state==='offline')return status('offline','LOCAL_CONNECTION_OFFLINE',local,remote);
    if(local.state!=='online')return status('checking','LOCAL_CONNECTION_CHECKING',local,remote);
    if(remote.state==='offline')return status('offline','REMOTE_OFFLINE_LOCAL_READY',local,remote);
    if(remote.state==='checking')return status('checking','REMOTE_CHECKING_LOCAL_READY',local,remote);
    return status('online',remote.state==='unconfigured'?'LOCAL_READY_REMOTE_UNCONFIGURED':'CONNECTIONS_READY',local,remote);
  }
  return {read(){
    const age=now()-cachedAt;
    if(cached&&age<0){cachedAt=now();return Promise.resolve(clone(cached));}
    if(cached&&age>=0&&age<2000)return Promise.resolve(clone(cached));
    if(!pending)pending=sample().then(value=>{cached=value;cachedAt=now();return value;}).catch(()=>status('checking','HEALTH_UNAVAILABLE',component('checking','HEALTH_UNAVAILABLE'),component('checking','HEALTH_UNAVAILABLE'))).finally(()=>{pending=null;});
    return pending.then(clone);
  }};
}
module.exports={createDashboardHealth,createPassiveProbes};
