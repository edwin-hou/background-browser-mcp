'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const execFileAsync = promisify(execFile);
const { chromeExecutable } = require('./runtime-paths.cjs');
const MANAGER_PIPE = '\\\\.\\pipe\\BackgroundBrowserMCP-manager-v1';
const LOGIN_PIPE = '\\\\.\\pipe\\BackgroundBrowserMCP-login-v1';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(file, value) { const temp = file+'.'+process.pid+'.'+randomUUID()+'.tmp'; fs.writeFileSync(temp, JSON.stringify(value), { flag:'wx', mode:0o600 }); fs.renameSync(temp,file); }
function pipeFor(root) { return '\\\\.\\pipe\\BackgroundBrowserMCP-availability-'+createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0,16); }
function pipeGreeting(address, timeout=1000) {
  return new Promise(resolve => { const socket=net.connect(address); let text='', done=false;
    const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};
    socket.setTimeout(timeout,()=>finish(null)); socket.setEncoding('utf8'); socket.on('error',()=>finish(null)); socket.on('end',()=>finish(null));
    socket.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>4096)return finish(null);if(text.includes('\n')){try{finish(JSON.parse(text.slice(0,text.indexOf('\n'))));}catch{finish(null);}}});
  });
}
function policy(root) { return read(path.join(root,'availability-config.json'))?.enabled === true; }
function setPolicy(root,enabled) { write(path.join(root,'availability-config.json'),{version:1,enabled,updatedAt:new Date().toISOString()}); }
function requestStops(root) { for(const file of ['service.stop','setup/portal.stop'])fs.writeFileSync(path.join(root,file),''); }
class InspectionError extends Error {
  constructor(code, action, phase, elapsedMs, source = {}) {
    super('Process inspection failed.'); this.code = code;
    // Persist classifications and sizes only. Raw child output/messages can
    // contain private command lines, URLs or authentication material.
    this.inspection = {
      action: action === 'terminate' ? 'terminate' : 'scan', phase,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      killed: source.killed === true,
      signal: ['SIGTERM','SIGKILL','SIGABRT'].includes(source.signal) ? source.signal : null,
      exitCode: Number.isInteger(source.code) ? source.code : null,
      stdoutBytes: Buffer.byteLength(source.stdout || ''), stderrBytes: Buffer.byteLength(source.stderr || '')
    };
  }
}
async function inspectProcess(action, execute, now = Date.now) {
  const started = now(); let result;
  try { result = await execute(); }
  catch (error) {
    const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'INSPECTION_OUTPUT_LIMIT' :
      error.killed === true ? 'INSPECTION_TIMEOUT' :
      ['ENOENT','EACCES','EPERM','ETIMEDOUT'].includes(error.code) ? error.code :
      Number.isInteger(error.code) ? 'INSPECTION_EXIT' : 'INSPECTION_FAILED';
    throw new InspectionError(code, action, 'execute', now()-started, error);
  }
  let data;
  try { data = JSON.parse(result.stdout); }
  catch { throw new InspectionError('INSPECTION_INVALID_JSON', action, 'parse', now()-started, result); }
  if (data?.ok !== true || (action === 'scan' && !Array.isArray(data.processes))) {
    throw new InspectionError('INSPECTION_INVALID_RESPONSE', action, 'validate', now()-started, result);
  }
  return data;
}
function defaultAdapter(root, {onEvent=()=>{},spawnProcess=spawn} = {}) {
  const ownedChildren = new Set();
  let cachedScan = null;
  const helper=path.join(__dirname,'availability-processes.ps1');
  const chromeImage=chromeExecutable(root);
  const powershell=path.join(process.env.SystemRoot || 'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const inspect=async(action,record)=>{
    const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Action',action,'-InstallationRoot',root,'-NodeExecutable',process.execPath,'-ChromeExecutable',chromeImage];
    if(record)args.push('-TargetPid',String(record.pid),'-BirthTicks',record.birthTicks);
    return inspectProcess(action,()=>execFileAsync(powershell,args,{shell:false,windowsHide:true,timeout:12000,maxBuffer:1024*1024}));
  };
  return {
    scan:async({allowCached=false,managerPid}={})=>{
      if(allowCached&&cachedScan&&Date.now()-cachedScan.at<60000&&cachedScan.records.some(record=>record.kind==='service'&&record.pid===managerPid))return cachedScan.records.map(record=>({...record}));
      const records=(await inspect('scan')).processes;cachedScan={at:Date.now(),records};return records;
    },
    terminate:async record=>{cachedScan=null;return inspect('terminate',record);},
    start:async kind=>{
      cachedScan=null;
      const script=path.join(root,kind==='service'?'service.cjs':'setup/portal.cjs');
      // On Windows a non-detached child belongs to libuv's kill-on-close job.
      // A controller crash must leave healthy workers available for adoption.
      const child=spawnProcess(process.execPath,[script],{cwd:root,shell:false,windowsHide:true,stdio:'ignore',detached:true});
      // Keep the spawned process handle alive. Never kill an unrelated PID through a broad process-name operation.
      ownedChildren.add(child);
      child.on('error',()=>{ownedChildren.delete(child);});
      child.once('exit',(code,signal)=>{
        ownedChildren.delete(child);
        try { onEvent({event:'worker-exited',at:new Date().toISOString(),worker:kind,pid:child.pid,
          exitCode:Number.isInteger(code)?code:null,signal:['SIGTERM','SIGKILL','SIGABRT'].includes(signal)?signal:null}); } catch {}
      });
      if(!child.pid)throw new Error('worker-spawn-failed');
      child.unref();
      return {pid:child.pid,kind};
    },
    manager:()=>pipeGreeting(MANAGER_PIPE),
    portal:async()=>{try{const response=await fetch('http://127.0.0.1:8936/',{signal:AbortSignal.timeout(1200),redirect:'error'});return response.status===403&&(await response.text())==='Open your private setup shortcut.';}catch{return false;}},
    paused:async()=>{const marker=read(path.join(root,'login.pause'));if(!marker?.token)return false;const greeting=await pipeGreeting(LOGIN_PIPE);return greeting?.token===marker.token&&greeting.pid===marker.pid;},
    stop:()=>requestStops(root),
    now:()=>Date.now()
  };
}
function createSupervisor({root,adapter=defaultAdapter(root),enabled=()=>policy(root),intervalMs=5000,onEvent=()=>{}}) {
  const workers={service:{failures:0,retryAt:0},portal:{failures:0,retryAt:0}};
  let stopped=false,lastStatus={status:'starting'},pending=null;
  const event=(name,extra={})=>onEvent({event:name,at:new Date(adapter.now()).toISOString(),...extra});
  async function tickInternal() {
    if(!enabled()){lastStatus={status:'disabled',enabled:false};return lastStatus;}
    const [pause,manager,portalHealthy]=await Promise.all([adapter.paused(),adapter.manager(),adapter.portal()]);
    // Healthy steady state avoids compiling a native helper / enumerating Windows processes every five seconds.
    // Any health failure and every mutation/recheck below forces a fresh identity scan.
    const records=await adapter.scan({allowCached:Boolean(manager&&portalHealthy),managerPid:manager?.pid});
    for(const kind of ['service','portal']) {
      const worker=workers[kind],matches=records.filter(record=>record.kind===kind);
      const existing=kind==='service'?(matches.find(record=>record.pid===manager?.pid)||matches[0]):matches[0];
      if(existing){
        if(worker.pid!==existing.pid||worker.birthTicks!==existing.birthTicks)event('worker-adopted',{worker:kind,pid:existing.pid});
        worker.pid=existing.pid;worker.birthTicks=existing.birthTicks;worker.failures=0;worker.retryAt=0;
        worker.healthy=kind==='service'?manager?.pid===existing.pid:portalHealthy;
        continue;
      }
      if(worker.pid)event('worker-missing',{worker:kind,previousPid:worker.pid});
      worker.pid=null;worker.birthTicks=null;worker.healthy=false;
      if(kind==='service'&&pause){worker.waitingForLogin=true;continue;}
      worker.waitingForLogin=false;
      if(adapter.now()<worker.retryAt)continue;
      try {
        // The authoritative parent is absent. Recheck before each orphan termination to avoid a competing launcher race.
        const orphanKinds=kind==='service'?['mcp','chrome']:['ngrok','gateway'];
        for(const orphanKind of orphanKinds)for(const orphan of records.filter(record=>record.kind===orphanKind)) {
          const current=await adapter.scan();
          if(current.some(record=>record.kind===kind))throw new Error('parent-appeared');
          if(kind==='service'&&await adapter.paused())throw new Error('manual-login-active');
          if(current.some(record=>record.pid===orphan.pid&&record.birthTicks===orphan.birthTicks&&record.kind===orphan.kind)) {
            await adapter.terminate(orphan);event('orphan-recovered',{worker:kind,processKind:orphan.kind,pid:orphan.pid});
          }
        }
        if(!enabled())break;
        const latest=await adapter.scan();
        if(latest.some(record=>record.kind===kind))continue;
        if(kind==='service'&&await adapter.paused())continue;
        if(!enabled())break;
        // Old consumable stop commands must not immediately stop an explicitly enabled replacement.
        // Durable enabled:false is the authoritative intentional-stop policy.
        const marker=path.join(root,kind==='service'?'service.stop':'setup/portal.stop');
        try{fs.unlinkSync(marker);}catch(error){if(error.code!=='ENOENT')throw error;}
        const child=await adapter.start(kind);worker.pid=child.pid;worker.birthTicks=child.birthTicks||null;
        worker.failures++;worker.retryAt=adapter.now()+Math.min(60000,1000*2**Math.min(worker.failures,6));
        event('worker-started',{worker:kind,pid:child.pid});
      }catch{
        worker.failures++;worker.retryAt=adapter.now()+Math.min(60000,1000*2**Math.min(worker.failures,6));
        event('recovery-deferred',{worker:kind});
      }
    }
    lastStatus={status:pause?'manual-login-active':'supervising',enabled:true,manualLoginActive:pause,checkedAt:new Date(adapter.now()).toISOString(),workers:JSON.parse(JSON.stringify(workers))};
    return lastStatus;
  }
  function tick(){
    if(pending)return pending;
    pending=tickInternal().catch(error=>{
      const errorCode=error instanceof InspectionError ? error.code : ['ETIMEDOUT','ENOENT','EACCES','EPERM'].includes(error?.code)?error.code:'INSPECTION_FAILED';
      const inspection=error instanceof InspectionError ? {inspection:error.inspection} : {};
      for(const worker of Object.values(workers))worker.healthy=false;
      lastStatus={status:'health-inspection-failed',enabled:enabled(),checkedAt:new Date(adapter.now()).toISOString(),errorCode,...inspection,workers:JSON.parse(JSON.stringify(workers))};
      event('health-inspection-failed',{errorCode,...inspection});
      throw error;
    }).finally(()=>{pending=null;});
    return pending;
  }
  async function run(){while(!stopped&&enabled()){try{await tick();}catch{}if(!stopped&&enabled())await sleep(intervalMs);}return lastStatus;}
  async function disable({timeoutMs=20000}={}) {
    stopped=true;adapter.stop();
    if(pending)await pending.catch(()=>{});
    // Reissue after an in-flight repair finishes so it cannot consume the only stop marker.
    adapter.stop();
    const until=adapter.now()+timeoutMs;
    let remaining=[];
    while(adapter.now()<until){try{remaining=(await adapter.scan()).filter(p=>['service','portal'].includes(p.kind));if(!remaining.length)break;}catch{}await sleep(250);}
    // Only reap children after their authoritative parent is actually absent; never force-kill a live parent.
    try{const remainingRecords=await adapter.scan();remaining=remainingRecords.filter(p=>['service','portal'].includes(p.kind));for(const orphan of remainingRecords){const parent=['mcp','chrome'].includes(orphan.kind)?'service':['ngrok','gateway'].includes(orphan.kind)?'portal':null;if(parent&&!remainingRecords.some(p=>p.kind===parent)){if(parent==='service'&&await adapter.paused())continue;await adapter.terminate(orphan);}}}catch{event('disabled-orphan-cleanup-deferred');}
    lastStatus={status:remaining.length?'disabled-workers-still-running':'disabled',enabled:false};return lastStatus;
  }
  return {tick,run,disable,status:()=>lastStatus,stop:()=>{stopped=true;}};
}
async function main(args=process.argv.slice(2)) {
  const rootIndex=args.indexOf('--root'),root=path.resolve(rootIndex>=0?args[rootIndex+1]:__dirname);
  const pipe=pipeFor(root),statusFile=path.join(root,'availability-state.json');
  if(args.includes('--enable')){setPolicy(root,true);console.log(JSON.stringify({enabled:true,supervisorRunning:Boolean(await pipeGreeting(pipe))}));return;}
  if(args.includes('--disable')){setPolicy(root,false);requestStops(root);console.log(JSON.stringify({enabled:false,stopRequested:true}));return;}
  if(args.includes('--status')){console.log(JSON.stringify({enabled:policy(root),supervisorRunning:Boolean(await pipeGreeting(pipe)),state:read(statusFile)}));return;}
  if(!policy(root))return;
  let supervisor;
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.end(JSON.stringify({pid:process.pid,status:supervisor?.status().status||'starting'})+'\n');});
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});}catch(error){if(error.code==='EADDRINUSE')return;throw error;}
  const logFile=path.join(root,'availability.log');
  const emit=entry=>{try{if(fs.existsSync(logFile)&&fs.statSync(logFile).size>262144){try{fs.unlinkSync(logFile+'.previous');}catch{}fs.renameSync(logFile,logFile+'.previous');}fs.appendFileSync(logFile,JSON.stringify(entry)+'\n',{mode:0o600});}catch{}};
  supervisor=createSupervisor({root,adapter:defaultAdapter(root,{onEvent:emit}),onEvent:emit});
  const timer=setInterval(()=>{try{write(statusFile,{pid:process.pid,...supervisor.status()});}catch{}},1000);timer.unref();
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>supervisor.stop());
  try{await supervisor.run();if(!policy(root))await supervisor.disable();}
  finally{clearInterval(timer);try{write(statusFile,{pid:process.pid,...supervisor.status()});}catch{}await new Promise(resolve=>server.close(resolve));}
}
module.exports={createSupervisor,pipeFor,policy,setPolicy,requestStops,defaultAdapter,inspectProcess};
if(require.main===module)main().catch(error=>{try{write(path.join(__dirname,'availability-last-error.json'),{at:new Date().toISOString(),code:error.code||null,name:error.name||'Error'});}catch{}console.error('Availability supervisor stopped unexpectedly.');process.exitCode=1;});
