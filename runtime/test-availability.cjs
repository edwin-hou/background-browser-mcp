'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSupervisor, setPolicy, policy, pipeFor, inspectProcess, defaultAdapter } = require('./availability.cjs');
let checks=0;
function ok(value,message){assert.ok(value,message);checks++;}
const base=path.join(__dirname,'test-work');fs.mkdirSync(base,{recursive:true});
const roots=[];
const rec=(kind,pid,birthTicks=String(pid)+'000')=>({kind,pid,birthTicks});
function fixture(initial,{pause=false,failStart=false}={}){
  const root=fs.mkdtempSync(path.join(base,'case-'));roots.push(root);fs.mkdirSync(path.join(root,'setup'));
  let records=initial.map(x=>({...x})),clock=10000,nextPid=1000,scanHook=null,enabled=true;
  const events=[],started=[],terminated=[];let stops=0,scans=0;
  const adapter={
    scan:async()=>{scans++;if(scanHook)scanHook(scans);return records.map(x=>({...x}));},
    paused:async()=>pause,
    manager:async()=>{const p=records.find(p=>p.kind==='service');return p?{pid:p.pid}:null;},
    portal:async()=>records.some(p=>p.kind==='portal'),
    start:async kind=>{started.push(kind);if(failStart)throw new Error('synthetic spawn failure');const process=rec(kind,++nextPid);records.push(process);return process;},
    terminate:async process=>{const current=records.find(p=>p.pid===process.pid);assert.equal(current?.birthTicks,process.birthTicks,'Adapter must never receive reused-PID identity');terminated.push({...process});records=records.filter(p=>p.pid!==process.pid);return {ok:true};},
    stop:()=>{stops++;},now:()=>clock
  };
  const supervisor=createSupervisor({root,adapter,enabled:()=>enabled,onEvent:e=>events.push(e)});
  return{root,adapter,supervisor,events,started,terminated,get records(){return records;},set records(value){records=value;},set clock(value){clock=value;},set enabled(value){enabled=value;},set hook(value){scanHook=value;},get stops(){return stops;},get scans(){return scans;}};
}
(async()=>{
  try{
    let f=fixture([rec('service',10),rec('portal',11),rec('chrome',12),rec('mcp',13),rec('gateway',14),rec('ngrok',15)]);
    const state=await f.supervisor.tick();
    ok(f.started.length===0&&f.terminated.length===0,'Working parents and all children are adopted without interruption.');
    ok(state.workers.service.pid===10&&state.workers.portal.pid===11&&state.workers.service.healthy&&state.workers.portal.healthy,'Adoption reports the existing healthy parents.');
    f.records=f.records.filter(record=>record.kind!=='portal');await f.supervisor.tick();
    ok(f.events.some(event=>event.event==='worker-missing'&&event.worker==='portal'&&event.previousPid===11),'A disappeared adopted parent records its previous PID.');

    f=fixture([rec('service',16),rec('portal',17)]);await f.supervisor.tick();
    f.adapter.scan=async()=>{const error=new Error('Sensitive internal details must stay private');error.code='ETIMEDOUT';throw error;};
    await assert.rejects(()=>f.supervisor.tick());
    const degraded=f.supervisor.status();
    ok(degraded.status==='health-inspection-failed'&&degraded.errorCode==='ETIMEDOUT'&&!degraded.workers.service.healthy&&!degraded.workers.portal.healthy,'A failed inspection clears stale healthy status and records only a safe error code.');
    ok(!JSON.stringify({degraded,events:f.events}).includes('Sensitive internal details'),'Inspection errors never copy raw error messages into status or logs.');

    const privateText='fixture-private-token-and-url';
    const failedInspection=async(source)=>{try{await inspectProcess('scan',async()=>{throw Object.assign(new Error(privateText),source);},()=>500);assert.fail('Inspection must fail');}catch(error){return error;}};
    const timeout=await failedInspection({killed:true,signal:'SIGTERM',stdout:privateText,stderr:privateText});
    ok(timeout.code==='INSPECTION_TIMEOUT'&&timeout.inspection.killed&&timeout.inspection.signal==='SIGTERM','A child timeout is classified separately from generic inspection failures.');
    const nonzero=await failedInspection({code:1,killed:false,stderr:privateText});
    ok(nonzero.code==='INSPECTION_EXIT'&&nonzero.inspection.exitCode===1,'A helper exit code survives only as safe structured metadata.');
    const overlimit=await failedInspection({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',killed:true,stdout:privateText});
    ok(overlimit.code==='INSPECTION_OUTPUT_LIMIT','Output-limit termination is not mislabeled as a timeout.');
    let invalidJson;try{await inspectProcess('scan',async()=>({stdout:privateText,stderr:privateText}));}catch(error){invalidJson=error;}
    ok(invalidJson.code==='INSPECTION_INVALID_JSON'&&invalidJson.inspection.phase==='parse','Invalid JSON is distinguished from a process execution failure.');
    await assert.rejects(()=>inspectProcess('scan',async()=>({stdout:'{"ok":true}',stderr:''})),{code:'INSPECTION_INVALID_RESPONSE'});checks++;
    const good=await inspectProcess('scan',async()=>({stdout:'{"ok":true,"processes":[]}',stderr:''}));
    ok(good.ok&&good.processes.length===0,'An empty valid scan is accepted so a disappeared parent can recover.');
    ok(!JSON.stringify([timeout.inspection,nonzero.inspection,overlimit.inspection,invalidJson.inspection]).includes(privateText),'Structured diagnostics retain sizes without private output or raw messages.');
    f.adapter.scan=async()=>{throw timeout;};await assert.rejects(()=>f.supervisor.tick());
    ok(f.supervisor.status().errorCode==='INSPECTION_TIMEOUT'&&f.supervisor.status().inspection.stdoutBytes===Buffer.byteLength(privateText),'Supervisor status carries the safe inspection classification and sizes.');
    ok(f.started.length===0&&f.terminated.length===0&&!f.supervisor.status().workers.service.healthy,'Failed identity inspection never starts or terminates a process or retains stale healthy status.');
    f.adapter.scan=async()=>f.records;await f.supervisor.tick();
    ok(f.supervisor.status().workers.service.healthy&&f.supervisor.status().workers.portal.healthy&&f.started.length===0,'A recovered inspection adopts the same working parents without restarting them.');
    f.adapter.manager=async()=>null;f.adapter.portal=async()=>false;
    const disconnected=await f.supervisor.tick();
    ok(!disconnected.workers.service.healthy&&!disconnected.workers.portal.healthy&&f.started.length===0&&f.terminated.length===0,'Disconnected health endpoints are reported unhealthy while existing parent processes are preserved.');

    const childFixture=fixture([]),child=new EventEmitter(),exitEvents=[];child.pid=12345;let unrefs=0;child.unref=()=>{unrefs++;};
    fs.writeFileSync(path.join(childFixture.root,'runtime-settings.json'),JSON.stringify({chromeExecutable:__filename}));
    const tracked=defaultAdapter(childFixture.root,{onEvent:event=>exitEvents.push(event),spawnProcess:(image,args,options)=>{assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.detached,true);assert.equal(options.stdio,'ignore');return child;}});
    await tracked.start('service');ok(unrefs===1,'A detached worker does not hold its repair controller open.');child.emit('exit',17,'SIGTERM');
    ok(exitEvents.length===1&&exitEvents[0].event==='worker-exited'&&exitEvents[0].pid===child.pid&&exitEvents[0].exitCode===17&&exitEvents[0].signal==='SIGTERM','An exact spawned parent handle records its exit code and signal.');
    ok(!JSON.stringify(exitEvents).includes('arguments')&&!JSON.stringify(exitEvents).includes('chromeExecutable'),'Owned-child exit receipts contain no launch arguments, URLs or environment.');

    f=fixture([rec('service',20),rec('chrome',21),rec('mcp',22),rec('gateway',23),rec('ngrok',24)]);
    await f.supervisor.tick();
    ok(f.started.join(',')==='portal','Portal death starts only a replacement portal.');
    ok(f.terminated.map(p=>p.kind).join(',')==='ngrok,gateway','Portal orphan recovery reaps only transport children.');
    ok(f.records.some(p=>p.pid===20)&&f.records.some(p=>p.pid===21)&&f.records.some(p=>p.pid===22),'Portal repair preserves manager, browser, and MCP.');
    await f.supervisor.tick();ok(f.started.length===1,'A recovered live portal is not duplicated on the next check.');

    f=fixture([rec('portal',30),rec('mcp',31),rec('chrome',32),rec('gateway',33),rec('ngrok',34)]);
    await f.supervisor.tick();
    ok(f.started.join(',')==='service','Manager death starts only a replacement manager.');
    ok(f.terminated.map(p=>p.kind).join(',')==='mcp,chrome','Manager orphan recovery reaps only backend/browser children.');
    ok(f.records.some(p=>p.pid===30)&&f.records.some(p=>p.pid===33)&&f.records.some(p=>p.pid===34),'Manager repair preserves portal, gateway, and tunnel.');

    f=fixture([rec('portal',40),rec('mcp',41),rec('chrome',42)],{pause:true});
    const paused=await f.supervisor.tick();
    ok(paused.manualLoginActive&&f.started.length===0&&f.terminated.length===0,'A verified manual login suppresses browser restart and orphan termination.');

    f=fixture([rec('portal',50),rec('chrome',51)]);
    f.hook=n=>{if(n===2)f.records=[rec('portal',50),rec('chrome',51,'NEW-BIRTH')];};
    await f.supervisor.tick();
    ok(f.terminated.length===0,'A reused PID with a different creation identity is not terminated.');

    f=fixture([rec('portal',60),rec('chrome',61)]);
    f.hook=n=>{if(n===2)f.records.push(rec('service',62));};
    await f.supervisor.tick();
    ok(f.terminated.length===0&&f.started.length===0,'A parent appearing during repair cancels orphan termination and replacement.');

    f=fixture([rec('portal',70)],{failStart:true});
    await f.supervisor.tick();await f.supervisor.tick();
    ok(f.started.length===1,'Failed startup uses backoff rather than launching repeatedly in the same interval.');
    f.clock=12000;await f.supervisor.tick();ok(f.started.length===2,'Startup retries when the backoff expires.');

    f=fixture([]);f.enabled=false;await f.supervisor.tick();
    ok(f.started.length===0&&f.scans===0,'Durable disabled state suppresses all respawning.');
    const disabled=await f.supervisor.disable({timeoutMs:0});
    ok(disabled.status==='disabled'&&f.stops===2,'Disable issues controlled stop markers and confirms no remaining workers.');

    f=fixture([rec('service',80),rec('portal',81)]);f.enabled=false;
    const blocked=await f.supervisor.disable({timeoutMs:0});
    ok(blocked.status==='disabled-workers-still-running'&&f.terminated.length===0,'Disable reports hung/live parents instead of force-killing them or falsely claiming all stopped.');

    f=fixture([rec('gateway',90),rec('ngrok',91)]);f.enabled=false;
    await f.supervisor.disable({timeoutMs:0});
    ok(f.terminated.length===2,'Disable may clean up verified transport orphans after their parent is gone.');

    f=fixture([rec('portal',100)]);
    f.hook=n=>{if(n===2)f.enabled=false;};
    await f.supervisor.tick();ok(f.started.length===0,'A disable arriving during pre-spawn inspection prevents replacement.');

    f=fixture([]);setPolicy(f.root,true);ok(policy(f.root),'Enable policy persists explicitly.');setPolicy(f.root,false);ok(!policy(f.root),'Disable policy persists explicitly.');
    ok(pipeFor(f.root)===pipeFor(f.root)&&pipeFor(f.root)!==pipeFor(f.root+'-different'),'Supervisor singleton identity is stable and installation scoped.');
    ok(f.events.every(event=>!('token'in event)&&!('arguments'in event)&&!('url'in event)),'Supervisor receipts contain no authentication values, tool arguments, or page URLs.');
    console.log(JSON.stringify({ok:true,checks,realServicesTouched:false,browserLaunched:false,fixturesOnly:true}));
  }finally{for(const root of roots){const absolute=path.resolve(root),boundary=path.resolve(base)+path.sep;if(!absolute.startsWith(boundary))throw new Error('Unsafe test cleanup');fs.rmSync(absolute,{recursive:true,force:true});}}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
