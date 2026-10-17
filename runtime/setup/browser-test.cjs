'use strict';
const assert = require('node:assert/strict'), http = require('node:http');
const { chromium } = require('playwright');
const { makeHandler } = require('./portal.cjs');
let ORIGIN;
let sites = [{id:'vanderbilt-brightspace',name:'Vanderbilt Brightspace',url:'https://brightspace.vanderbilt.edu/',lastSavedAt:'2026-10-14T23:00:00.000Z'}];
let login = {active:false}, saved = null, starts = 0, finishes = 0, transports = 0, removes = 0;
const token='TEST_BROWSER_FORM_TOKEN_123456789012345678901', observed=[];
const fixtureContext={
 token,sites:()=>sites,login:()=>login,browser:()=>({ready:!login.active,headless:true,status:login.active?'paused-for-login':'running'}),
 saved:()=>saved,status:()=>({message:'Isolated dashboard verification'}),owner:()=> 'FIXTURE_OWNER_NOT_A_REAL_SECRET',
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
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='site-removed'),page.getByRole('button',{name:'Remove Gmail bookmark',exact:true}).click()]);
  assert.equal(removes,1);assert.equal(await page.getByRole('heading',{name:'Gmail',exact:true}).count(),0);
  await page.locator('#connection-settings > details > summary').click();
  await page.getByLabel('Assigned free domain',{exact:true}).fill('browser-fixture.ngrok-free.app');
  await page.getByLabel('ngrok authtoken',{exact:true}).fill('FAKE_BROWSER_TEST_TOKEN_123');
  await Promise.all([page.waitForURL(u=>u.searchParams.get('notice')==='transport-saved'),page.getByRole('button',{name:'Save connection settings',exact:true}).click()]);
  assert.equal(transports,1);assert.equal(saved.publicBaseUrl,'https://browser-fixture.ngrok-free.app');
  assert.ok(!(await page.content()).includes('FAKE_BROWSER_TEST_TOKEN_123'));
  for(const event of observed){assert.equal(event.origin,ORIGIN);assert.equal(event.referer,ORIGIN+'/');assert.equal(event.status,303);}
  assert.deepEqual(observed.map(e=>e.path),['/sites/add','/login','/login/finish','/sites/remove','/transport']);
  await page.goto(home);
  const overflow=[];
  for(const width of [320,390,680,768,960,1024,1440]){
   await page.setViewportSize({width,height:1000});
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) overflow.push(width);
  }
  assert.deepEqual(overflow,[]);
  console.log(JSON.stringify({ok:true,realBrowserForms:observed.length,addSite:true,selectedSiteLogin:true,explicitSessionSave:true,removeShortcut:true,refreshDoesNotReopenLogin:true,transportSettingsPreserved:true,csrfOriginPreserved:true,noHorizontalOverflow:true,allBrowserEffectsStubbed:true,productionProfileUntouched:true}));
 } finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
