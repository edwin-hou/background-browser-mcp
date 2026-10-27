'use strict';
// Windows process-lifetime regression. No browser, account or installed service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (process.platform !== 'win32') { console.log('Windows-only worker detachment regression skipped.'); return; }
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'background-browser-detachment-'));
  const controllerFile = path.join(fixture, 'controller.cjs');
  const helper = path.join(fixture, 'terminate-fixture.ps1');
  const moduleFile = path.join(__dirname, 'availability.cjs');
  const results = [];
  let cleanupConfirmed = true;
  await fs.writeFile(path.join(fixture, 'runtime-settings.json'), JSON.stringify({ chromeExecutable: process.execPath }));
  await fs.writeFile(path.join(fixture, 'service.cjs'), `const fs=require('node:fs');let n=0;const file=process.argv[1]+'.heartbeat';const beat=()=>fs.writeFileSync(file,JSON.stringify({pid:process.pid,n:++n}));beat();setInterval(beat,50);`);
  await fs.writeFile(controllerFile, `const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');const root=process.argv[2];const mode=process.argv[3];const moduleFile=process.argv[4];(async()=>{const child=mode==='baseline'?spawn(process.execPath,[path.join(root,'service.cjs')],{shell:false,windowsHide:true,stdio:'ignore'}):await require(moduleFile).defaultAdapter(root).start('service');fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);})().catch(()=>process.exit(1));`);
  await fs.writeFile(helper, String.raw`param([int]$Controller,[int]$Worker,[int]$Driver,[string]$Root,[string]$NodeImage)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FixtureNative{[DllImport("kernel32.dll",SetLastError=true)]public static extern bool TerminateProcess(IntPtr handle,uint code);}'
function OpenFixture([int]$Id,[int]$Parent,[string]$Script) {
  $p=[Diagnostics.Process]::GetProcessById($Id)
  try {
    $handle=$p.Handle;$birth=$p.StartTime.ToUniversalTime().Ticks
    $row=Get-CimInstance Win32_Process -Filter "ProcessId=$Id"
    if($p.HasExited -or !$row -or $row.ParentProcessId -ne $Parent -or [IO.Path]::GetFullPath($row.ExecutablePath).ToLowerInvariant() -ne [IO.Path]::GetFullPath($NodeImage).ToLowerInvariant() -or !$row.CommandLine.Contains($Script)){throw 'Fixture process identity mismatch.'}
    $observed=$row.CreationDate.ToUniversalTime().Ticks
    if(($birth-($birth%10)) -ne ($observed-($observed%10))){throw 'Fixture creation identity mismatch.'}
    return @{process=$p;handle=$handle;birth=$birth}
  }catch{$p.Dispose();throw}
}
function EndFixture($binding) {
  if($binding -and !$binding.process.HasExited){
    if($binding.process.StartTime.ToUniversalTime().Ticks -ne $binding.birth){throw 'Fixture process identity changed.'}
    if(![FixtureNative]::TerminateProcess($binding.handle,1) -and !$binding.process.HasExited){throw 'Fixture termination failed.'}
    if(!$binding.process.WaitForExit(5000)){throw 'Fixture did not exit.'}
  }
}
function ReadFixtureHeartbeat([string]$File,[int]$WorkerId) {
  try {
    $beat=Get-Content -LiteralPath $File -Raw|ConvertFrom-Json
    if($beat.pid -eq $WorkerId -and $beat.n -is [ValueType] -and $beat.n -gt 0){return $beat}
  }catch{}
  # The fixture writer can be between truncate and write. An incomplete read
  # is not evidence of either progress or failure.
  return $null
}
$parent=$null;$child=$null
try {
  $parent=OpenFixture $Controller $Driver (Join-Path $Root 'controller.cjs')
  $child=OpenFixture $Worker $Controller (Join-Path $Root 'service.cjs')
  $heartbeat=Join-Path $Root 'service.cjs.heartbeat'
  $readyWatch=[Diagnostics.Stopwatch]::StartNew();$before=$null
  while(!$before -and !$child.process.HasExited -and $readyWatch.ElapsedMilliseconds -lt 5000){
    $before=ReadFixtureHeartbeat $heartbeat $Worker
    if(!$before){Start-Sleep -Milliseconds 25}
  }
  if(!$before){throw 'The exact fixture worker did not publish a valid heartbeat.'}
  EndFixture $parent
  $survived=!$child.process.WaitForExit(800)
  $advanced=$false;$postExit=$null;$progressWatch=[Diagnostics.Stopwatch]::StartNew()
  while($survived -and !$child.process.HasExited -and $progressWatch.ElapsedMilliseconds -lt 5000){
    $beat=ReadFixtureHeartbeat $heartbeat $Worker
    if($beat){
      if(!$postExit){$postExit=$beat.n}
      elseif($beat.n -gt $postExit){$advanced=$true;break}
    }
    Start-Sleep -Milliseconds 25
  }
  EndFixture $child
  @{controllerExited=$parent.process.HasExited;workerSurvived=$survived;heartbeatAdvanced=$advanced;workerCleaned=$child.process.HasExited}|ConvertTo-Json -Compress
}finally{
  if($child){try{EndFixture $child}finally{$child.process.Dispose()}}
  if($parent){try{EndFixture $parent}finally{$parent.process.Dispose()}}
}
`);
  try {
    for (const mode of ['baseline', 'production']) {
      for (const file of ['ready.json', 'service.cjs.heartbeat']) {
        await fs.unlink(path.join(fixture, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      const child = spawn(process.execPath, [controllerFile, fixture, mode, moduleFile], { shell: false, windowsHide: true, stdio: 'ignore' });
      cleanupConfirmed = false;
      try {
        let ready;
        for (let attempt=0;attempt<100;attempt++) {
          try {
            ready=JSON.parse(await fs.readFile(path.join(fixture,'ready.json'),'utf8'));
            const beat=JSON.parse(await fs.readFile(path.join(fixture,'service.cjs.heartbeat'),'utf8'));
            if(ready.parent===child.pid&&beat.pid===ready.child&&Number.isSafeInteger(beat.n)&&beat.n>0)break;
          } catch {}
          await sleep(50);
        }
        assert.equal(ready?.parent,child.pid,'Only the exact spawned controller is eligible for termination.');
        const response=await execute(path.join(process.env.SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),[
          '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,
          '-Controller',String(ready.parent),'-Worker',String(ready.child),'-Driver',String(process.pid),'-Root',fixture,'-NodeImage',process.execPath
        ],{shell:false,windowsHide:true,timeout:25000,maxBuffer:100000});
        const result=JSON.parse(response.stdout);cleanupConfirmed=result.workerCleaned===true;
        results.push({mode,...result});
        assert.ok(result.controllerExited&&result.workerCleaned,'Exact fixture handles were terminated and confirmed exited.');
        if(mode==='baseline') assert.equal(result.workerSurvived,false,'The non-detached control reproduces Windows child loss on parent death.');
        else assert.ok(result.workerSurvived&&result.heartbeatAdvanced,'A production worker must survive abrupt controller death and keep working.');
      } finally { if(child.exitCode===null&&child.signalCode===null) child.kill(); }
    }
    console.log(JSON.stringify({ok:true,checks:6,results,realServicesTouched:false,browserLaunched:false}));
  } catch(error) {
    console.error(JSON.stringify({ok:false,results,realServicesTouched:false,browserLaunched:false}));
    throw error;
  } finally {
    if(cleanupConfirmed&&path.dirname(path.resolve(fixture))===path.resolve(os.tmpdir())&&path.basename(fixture).startsWith('background-browser-detachment-'))await fs.rm(fixture,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
