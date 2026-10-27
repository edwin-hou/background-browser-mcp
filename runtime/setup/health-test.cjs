'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {createDashboardHealth,createPassiveProbes}=require('./health.cjs');

async function main(){
  let checks=0;
  const check=(value,message)=>{assert.ok(value,message);checks++;};
  const boundary=await fs.mkdtemp(path.join(os.tmpdir(),'background-browser-health-'));
  const roots=[];
  const managerSecret='fixture-manager-private',loginSecret='fixture-login-private';
  const write=(root,file,value)=>fs.writeFile(path.join(root,file),JSON.stringify(value));
  async function fixture(){
    const root=await fs.mkdtemp(path.join(boundary,'case-'));roots.push(root);await fs.mkdir(path.join(root,'gateway'));
    await write(root,'availability-config.json',{enabled:true});
    await write(root,'service-state.json',{managerPid:41,managerToken:managerSecret,status:'running',ready:true,headless:true,updated:'2000-01-01T00:00:00Z',url:'https://private.example.invalid/?secret=fixture-private'});
    let clock=0;
    const values={manager:{pid:41,token:managerSecret},login:null,cdp:true,mcp:true,gateway:true,publicHealth:true},calls={};
    const probes=Object.fromEntries(Object.keys(values).map(key=>[key,async()=>{calls[key]=(calls[key]||0)+1;return values[key];}]));
    const health=createDashboardHealth({root,now:()=>clock,probes});
    return {root,values,calls,health,probes,async next(ms=5000){clock+=ms;return health.read();},advance(ms){clock+=ms;}};
  }
  let listener;
  try{
    let f=await fixture();
    let state=await f.health.read();
    check(state.mode==='checking'&&state.local.state==='checking','A first successful sample does not falsely advertise online.');
    const count=f.calls.manager;
    for(let n=0;n<5;n++)await f.health.read();
    check(f.calls.manager===count,'Two-second cache prevents repeated reads from advancing debounce.');
    state=await f.next();
    check(state.mode==='online'&&state.remote.state==='unconfigured'&&state.messageCode==='LOCAL_READY_REMOTE_UNCONFIGURED','Remote setup is optional when the local connection is healthy.');
    check(f.calls.gateway===undefined&&f.calls.publicHealth===undefined,'An unconfigured remote connection performs no tunnel or gateway probes.');
    check(state.local.state==='online','Old transition-receipt timestamps are not mistaken for stale heartbeats.');
    state.local.state='corrupted';
    check((await f.health.read()).local.state==='online','A caller cannot mutate cached status.');
    f.values.cdp=false;
    check((await f.next()).mode==='checking','One failed probe is still checking.');
    check((await f.next()).mode==='checking','Two failed probes do not report a confirmed outage.');
    state=await f.next();
    check(state.mode==='offline'&&state.local.detailCode==='CDP_UNREACHABLE','Three failed samples report a local outage.');
    f.values.cdp=true;
    check((await f.next()).mode==='checking','One recovery sample is not yet online.');
    check((await f.next()).mode==='online','Two recovery samples restore online state.');
    f.values.cdp=null;
    state=await f.next();
    check(state.mode==='checking'&&state.local.detailCode==='CDP_UNVERIFIED'&&!state.waitingForOwner,'Unrecognized responses are unknown, not reauthentication requests.');
    f.values.cdp=true;await f.next();
    await write(f.root,'availability-config.json',{enabled:false});
    const beforeStop={...f.calls};state=await f.next();
    check(state.mode==='stopped'&&state.messageCode==='BROWSER_STOPPED'&&!state.waitingForOwner,'An intentional stop is distinguished from an outage.');
    check(JSON.stringify(f.calls)===JSON.stringify(beforeStop),'Stopped policy suppresses all probes.');

    f=await fixture();await write(f.root,'login.pause',{pid:73,token:loginSecret});f.values.login={pid:73,token:loginSecret};
    state=await f.health.read();
    check(state.mode==='paused'&&state.waitingForOwner&&state.messageCode==='SIGN_IN_IN_PROGRESS','A matching live login pipe suppresses outage status.');
    check(!f.calls.manager&&!f.calls.cdp&&!f.calls.mcp&&!f.calls.publicHealth,'Manual sign-in performs no browser or tunnel health probe.');
    f.values.login={pid:73,token:'TEST_other-fixture-owner'};
    await write(f.root,'login-state.json',{active:true,status:'login-open',authenticationVerified:false});
    await f.next();state=await f.next();
    check(state.mode==='online'&&!state.waitingForOwner,'A stale marker or historical login state cannot suppress monitoring.');
    await write(f.root,'login.pause',{pid:73,token:''});f.values.login={pid:73,token:''};
    state=await f.next();check(state.mode==='online'&&!state.waitingForOwner,'An empty malformed ownership token cannot fabricate an intentional login pause.');
    f.values.manager={pid:41,token:'TEST_wrong-fixture-manager'};
    await f.next();await f.next();state=await f.next();
    check(state.mode==='offline'&&state.local.detailCode==='MANAGER_NOT_READY','A reused PID with a different live manager token is not accepted.');
    await fs.unlink(path.join(f.root,'availability-config.json'));
    state=await f.next();
    check(state.mode==='checking'&&state.messageCode==='POLICY_UNAVAILABLE','Missing policy is unknown rather than an invented intentional stop.');

    f=await fixture();await write(f.root,'gateway/config.json',{publicBaseUrl:'https://your-name.ngrok-free.app',ownerSecret:'fixture-never-display'});
    f.values.publicHealth=false;
    await f.health.read();await f.next();state=await f.next();
    check(state.mode==='offline'&&state.local.state==='online'&&state.remote.state==='offline'&&state.messageCode==='REMOTE_OFFLINE_LOCAL_READY','A tunnel outage is distinct from a working local browser.');
    check(f.calls.publicHealth===1,'Public health is cached across page polls.');
    f.values.publicHealth=true;
    await f.next(250000);
    check(f.calls.publicHealth===1,'Public health cannot be polled more often than every five minutes.');
    state=await f.next(50001);
    check(f.calls.publicHealth===2&&state.mode==='checking','A new public-health success begins debounced recovery.');
    state=await f.next();
    check(state.mode==='online'&&state.messageCode==='CONNECTIONS_READY','Two healthy cached samples confirm public-path recovery.');
    check(!JSON.stringify(state).includes('ngrok')&&!JSON.stringify(state).includes(managerSecret)&&!JSON.stringify(state).includes('fixture-never-display'),'Status contains no private domain, manager token or configuration secret.');
    f.values.gateway=false;const publicCalls=f.calls.publicHealth;
    await f.next();await f.next();state=await f.next();
    check(state.remote.state==='offline'&&state.remote.detailCode==='GATEWAY_UNREACHABLE'&&state.local.state==='online','A local gateway outage is separately classified.');
    check(f.calls.publicHealth===publicCalls,'An unreachable gateway does not cause unnecessary external probes.');
    f.values.gateway=true;f.advance(-60000);await f.health.read();await f.next();
    check(f.calls.publicHealth===publicCalls,'A backward clock adjustment cannot bypass the public-health cache interval.');

    for(const unsafe of ['http://127.0.0.1:8934','https://example.invalid','https://your-name.ngrok-free.app/path','https://owner:private@your-name.ngrok-free.app','https://your-name.ngrok-free.app/?private=fixture']){
      const item=await fixture();await write(item.root,'gateway/config.json',{publicBaseUrl:unsafe});await item.health.read();state=await item.next();
      check(state.remote.state==='checking'&&state.remote.detailCode==='REMOTE_CONFIG_UNAVAILABLE'&&!item.calls.publicHealth,'Unsafe or malformed public origin is never fetched.');
    }
    f=await fixture();f.probes.cdp=async()=>{f.calls.cdp=(f.calls.cdp||0)+1;await new Promise(resolve=>setTimeout(resolve,10));return true;};
    const concurrent=createDashboardHealth({root:f.root,now:()=>0,probes:f.probes});
    await Promise.all([concurrent.read(),concurrent.read(),concurrent.read()]);
    check(f.calls.manager===1&&f.calls.cdp===1,'Concurrent dashboard requests share one pending sample.');

    let behavior='valid',getMcp=0,headMcp=0;
    listener=http.createServer((request,response)=>{
      if(request.url==='/mcp'){if(request.method==='HEAD'){headMcp++;response.writeHead(405);response.end();}else{getMcp++;response.writeHead(500);response.end();}return;}
      if(behavior==='stall')return;
      if(behavior==='redirect'){response.writeHead(302,{Location:'https://not-followed.example.invalid/'});response.end();return;}
      if(behavior==='malformed'){response.end('<html>fixture sign-in</html>');return;}
      if(behavior==='oversized'){response.end('x'.repeat(80000));return;}
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify(request.url==='/json/version'?{Browser:'Fixture Chrome','Protocol-Version':'1.3',webSocketDebuggerUrl:'ws://127.0.0.1:'+listener.address().port+'/devtools/browser/fixture'}:{ok:true,authenticatedBrowserGateway:true}));
    });
    await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+listener.address().port;
    const real=createPassiveProbes({urls:{cdp:origin+'/json/version',mcp:origin+'/mcp',gateway:origin+'/health'}});
    check(await real.cdp()===true&&await real.gateway()===true,'Passive JSON probes recognize an isolated healthy CDP/gateway fixture.');
    check(await real.mcp()===true&&headMcp===1&&getMcp===0,'Raw MCP reachability uses HEAD and never opens GET/SSE or initializes a session.');
    behavior='malformed';
    check(await real.gateway()===null&&await real.cdp()===null,'HTML sign-in text is an unrecognized health response, never proof of expired account authentication.');
    behavior='oversized';check(await real.gateway()===null,'Health response bodies are bounded before being parsed or retained.');
    behavior='redirect';check(await real.gateway()===false,'Health requests do not follow redirects to another origin.');
    behavior='stall';check(await real.gateway()===false,'A stalled HTTP response is bounded by a passive-probe deadline.');
    assert.throws(()=>createPassiveProbes({urls:{gateway:'https://external.example.invalid/health'}}));checks++;
    check(await real.publicHealth('https://external.example.invalid')===null,'Default public probe rejects an arbitrary external origin.');
    console.log(JSON.stringify({ok:true,checks,realServicesTouched:false,browserLaunched:false,mcpSessionCreated:false,ephemeralHttpOnly:true}));
  }finally{
    if(listener?.listening){listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
    if(path.dirname(path.resolve(boundary))===path.resolve(os.tmpdir())&&path.basename(boundary).startsWith('background-browser-health-'))await fs.rm(boundary,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
