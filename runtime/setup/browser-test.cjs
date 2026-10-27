'use strict';
const assert = require('node:assert/strict'), http = require('node:http');
const { chromium } = require('playwright');
const { makeHandler, syncSavedSession } = require('./portal.cjs');
let ORIGIN;
let sites = [{id:'vanderbilt-brightspace',name:'Vanderbilt Brightspace',url:'https://brightspace.vanderbilt.edu/',lastSavedAt:'2026-10-14T23:00:00.000Z'}];
let login = {active:false}, saved = null, starts = 0, finishes = 0, transports = 0, removes = 0;
let healthMode = 'online', remoteState = 'unconfigured', accountObservations = [], statusUnavailable = false;
const token='TEST_BROWSER_FORM_TOKEN_123456789012345678901', observed=[];
const fixtureContext={
 token,sites:()=>sites,login:()=>login,browser:()=>({ready:!login.active,headless:true,status:login.active?'paused-for-login':'running'}),
 saved:()=>saved,status:()=>({message:'Isolated dashboard verification'}),owner:()=> 'FIXTURE_OWNER_NOT_A_REAL_SECRET',
 health:async()=>{if(statusUnavailable)throw new Error('Synthetic status failure.');return {version:1,checkedAt:new Date().toISOString(),mode:login.active?'paused':healthMode,messageCode:'SYNTHETIC_FIXTURE',local:{state:login.active?'paused':healthMode},remote:{state:remoteState},waitingForOwner:healthMode==='offline'};},
 accounts:()=>{syncSavedSession({markSaved:(id,savedAt)=>{sites=sites.map(s=>s.id===id?{...s,lastSavedAt:savedAt}:s);}},login);return sites.map(site=>({...accountObservations.find(a=>a.siteId===site.id),siteId:site.id,state:accountObservations.find(a=>a.siteId===site.id)?.state||'not-checked',savedAt:site.lastSavedAt||null}));},
 startLogin:async id=>{const site=sites.find(s=>s.id===id);assert.ok(site);starts++;login={active:true,status:'login-open',siteId:id,siteName:site.name,url:site.url};},
 finishLogin:async()=>{assert.ok(login.active);finishes++;sites=sites.map(s=>s.id===login.siteId?{...s,lastSavedAt:new Date().toISOString()}:s);login={active:false,status:'session-saved'};},
 addSite:async input=>{sites.push({id:'gmail-fixture',name:input.name,url:input.url});},
 removeSite:async id=>{sites=sites.filter(s=>s.id!==id);removes++;},
 save:async value=>{saved=value;transports++;}
};
(async()=>{
 let handler;
 const server=http.createServer(async(req,res)=>{if(req.method==='POST'){const origin=req.headers.origin,referer=req.headers.referer,path=new URL(req.url,ORIGIN).pathname;const oldWrite=res.writeHead;res.writeHead=function(status,...rest){observed.push({path,origin,referer,status});return oldWrite.call(this,status,...rest);};}await handler(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));ORIGIN='http://127.0.0.1:'+server.address().port;handler=makeHandler(fixtureContext,{origin:ORIGIN});
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,timeout:10000});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(); page.setDefaultTimeout(6000);page.setDefaultNavigationTimeout(6000);
  await context.route('**/*',route=>new URL(route.request().url()).origin===ORIGIN?route.continue():route.abort());
  const home=ORIGIN+'/?token='+token;
  await page.goto(home);
  await page.getByLabel('Website name',{exact:true}).fill('Gmail');
  await page.getByLabel('Website URL',{exact:true}).fill('https://mail.google.com/');
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='site-added'),page.getByRole('button',{name:'Add website',exact:true}).click()]);
  let card=page.locator('article.site-card').filter({has:page.getByRole('heading',{name:'Gmail',exact:true})});
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='login-started'),card.getByRole('button',{name:'Connect website',exact:true}).click()]);
  assert.equal(starts,1);assert.equal(await page.getByRole('button',{name:'Sign in again',exact:true}).isDisabled(),true);
  assert.ok(await page.getByRole('heading',{name:'Finish connecting Gmail',exact:true}).isVisible());
  await page.reload();assert.equal(starts,1,'GET reload must not reopen login');
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='session-saved'),page.getByRole('button',{name:'Save session & return to background',exact:true}).click()]);
  assert.equal(finishes,1);assert.equal(login.active,false);
  card=page.locator('article.site-card').filter({has:page.getByRole('heading',{name:'Gmail',exact:true})});
  assert.match(await card.innerText(),/Session saved/);
  assert.match(await page.locator('.browser-state').innerText(),/Running in background/);
  const refresh = async()=>{await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/status'),page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))]);};
  accountObservations=[{siteId:'gmail-fixture',state:'sign-in-required',observedAt:new Date().toISOString()}];
  await refresh();await page.getByRole('heading',{name:'One account needs sign-in',exact:true}).waitFor();
  assert.ok(await card.getByRole('button',{name:'Reconnect account',exact:true}).isVisible());
  await page.getByLabel('Website name',{exact:true}).fill('Unsaved draft is preserved');
  healthMode='offline';await refresh();await page.getByRole('heading',{name:'Background Browser is offline',exact:true}).waitFor();
  assert.match(await page.locator('.browser-state').innerText(),/Connection offline/);
  assert.equal(await page.getByLabel('Website name',{exact:true}).inputValue(),'Unsaved draft is preserved');
  healthMode='online';remoteState='online';accountObservations=[{siteId:'gmail-fixture',state:'verified',observedAt:new Date().toISOString()}];
  await refresh();await page.getByRole('heading',{name:'Your browser is connected',exact:true}).waitFor();assert.equal(await page.locator('#remote-connection-state').textContent(),'Reachable');assert.ok((await page.locator('#connection-health-detail').textContent()).includes('ChatGPT access and website sign-in are checked'));
  assert.match(await card.innerText(),/Last access verified/);
  statusUnavailable=true;for(let i=0;i<3;i++)await refresh();
  await page.getByRole('heading',{name:'Connection status is unavailable',exact:true}).waitFor();
  assert.match(await page.locator('.browser-state').innerText(),/Status unavailable/);
  statusUnavailable=false;await refresh();await page.getByRole('heading',{name:'Your browser is connected',exact:true}).waitFor();
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='login-started'),card.getByRole('button',{name:'Sign in again',exact:true}).click()]);
  assert.equal(starts,2);assert.ok(await page.getByRole('heading',{name:'Finish connecting Gmail',exact:true}).isVisible());
  login={active:false,status:'session-saved',siteId:'gmail-fixture',savedAt:new Date().toISOString()};
  accountObservations=[{siteId:'gmail-fixture',state:'not-checked',observedAt:null}];
  await refresh();await page.locator('.login-panel').waitFor({state:'hidden'});
  card=page.locator('article.site-card').filter({has:page.getByRole('heading',{name:'Gmail',exact:true})});
  assert.ok(await card.getByRole('button',{name:'Sign in again',exact:true}).isEnabled());
  assert.match(await card.locator('.session-state').innerText(),/Session saved/);
  assert.equal(finishes,1,'window-close refresh must not send a finish command or reopen the page');
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='site-removed'),page.getByRole('button',{name:'Remove Gmail bookmark',exact:true}).click()]);
  assert.equal(removes,1);assert.equal(await page.getByRole('heading',{name:'Gmail',exact:true}).count(),0);
  await page.locator('#connection-settings > details > summary').click();
  await page.getByLabel('Assigned free domain',{exact:true}).fill('browser-fixture.ngrok-free.app');
  await page.getByLabel('ngrok authtoken',{exact:true}).fill('FAKE_BROWSER_TEST_TOKEN_123');
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='transport-saved'),page.getByRole('button',{name:'Save connection settings',exact:true}).click()]);
  assert.equal(transports,1);assert.equal(saved.publicBaseUrl,'https://browser-fixture.ngrok-free.app');
  assert.ok(!(await page.content()).includes('FAKE_BROWSER_TEST_TOKEN_123'));
  for(const event of observed){assert.equal(event.origin,ORIGIN);assert.equal(event.referer,ORIGIN+'/');assert.equal(event.status,303);}
  assert.deepEqual(observed.map(e=>e.path),['/sites/add','/login','/login/finish','/login','/sites/remove','/transport']);
  await page.goto(home);
  const overflow=[];
  for(const width of [320,390,680,768,960,1024,1440]){
   await page.setViewportSize({width,height:1000});
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) overflow.push(width);
  }
  assert.deepEqual(overflow,[]);
  console.log(JSON.stringify({ok:true,realBrowserForms:observed.length,addSite:true,selectedSiteLogin:true,explicitSessionSave:true,windowCloseRefresh:true,removeShortcut:true,refreshDoesNotReopenLogin:true,transportSettingsPreserved:true,csrfOriginPreserved:true,liveOfflineStatus:true,observedSignInAttention:true,recoveryStatus:true,pollFailureVisible:true,unsavedFormPreserved:true,noHorizontalOverflow:true,allBrowserEffectsStubbed:true,productionProfileUntouched:true}));
 } finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
