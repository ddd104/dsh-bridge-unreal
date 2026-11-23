// Enumerate the actual editor registry; only use a disposable workspace project.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,realpath,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {UnrealBridge} from '../src/bridge.mjs';
import {assertSafeMcpCall} from '../src/mcp-policy.mjs';
import {verifyMcpCrud} from './mcp-crud-checks.mjs';

const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/mcp-coverage-e2e.mjs <engine-root> <disposable.uproject> <state-dir>');
const root=await realpath(fileURLToPath(new URL('../.test-state/',import.meta.url)));
const contained=path=>{const part=relative(root,path);return part!==''&&!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${sep}`);};
const projectPath=await realpath(resolve(project)),stateDir=resolve(stateRoot);
assert.ok(contained(projectPath)&&contained(stateDir),'Use paths inside the workspace .test-state');
await mkdir(stateDir,{recursive:true});assert.ok(contained(await realpath(stateDir)));
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:120000}).start();
const session='mcp-coverage',report={status:'running',projectPath,topLevel:[],toolsets:[]};
const decode=result=>{assert.notEqual(result?.isError,true,JSON.stringify(result));const value=result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);return Object.hasOwn(value,'returnValue')?value.returnValue:value;};
let child,processError,exitCode;
try{
  child=spawn(join(resolve(engine),'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[projectPath,'/Engine/Maps/Entry','-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound','-NoAutoSave',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`],{windowsHide:true,stdio:'ignore'});
  child.once('error',error=>{processError=error;});child.once('exit',(code,signal)=>{exitCode=code??signal;});
  const deadline=Date.now()+180000;
  while(!bridge.list().length){if(processError)throw processError;if(exitCode!==undefined)throw new Error(`Editor exited ${exitCode}`);if(Date.now()>deadline)throw new Error('Editor registration timed out');await new Promise(done=>setTimeout(done,200));}
  const editor=bridge.list()[0];assert.equal(editor.pid,child.pid);assert.equal((await realpath(editor.projectPath)).toLowerCase(),projectPath.toLowerCase());bridge.bind(session,editor.editorId);report.engineVersion=editor.engineVersion;
  report.topLevel=(await bridge.mcpTools(session)).tools;
  const rawDiscovery=await bridge.mcpToolsets(session);report.discovery=rawDiscovery;
  await writeFile(join(stateDir,'catalog.json'),JSON.stringify(report,null,2));
  const discoveryText=rawDiscovery.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const entries=[...discoveryText.matchAll(/^- ([A-Za-z_]\w*(?:\.\w+)+)(?::|$)/gm)].map(m=>m[1]);
  assert.ok(entries.length,discoveryText);
  for(const entry of entries){
    const name=typeof entry==='string'?entry:entry.name;
    const description=decode(await bridge.mcpDescribe(session,{toolsetName:name}));
    for(const tool of description.tools){
      try{assertSafeMcpCall({name:'call_tool',arguments:{toolset_name:name,tool_name:tool.name,arguments:{}}});tool.bridgeAccess='available';}
      catch(error){tool.bridgeAccess='blocked';tool.bridgeReason=error.details?.reason??error.code;}
    }
    report.toolsets.push({name,tools:description.tools});
    console.log(`${name}: ${description.tools.length} tools`);
    await writeFile(join(stateDir,'catalog.json'),JSON.stringify(report,null,2));
  }
  report.total=report.toolsets.reduce((n,s)=>n+s.tools.length,0);
  report.blocked=report.toolsets.flatMap(s=>s.tools.filter(t=>t.bridgeAccess!=='available').map(t=>t.fullName));
  assert.deepEqual(report.blocked,[],'Every discovered leaf must be exposed by default');
  console.log(`PASS: ${report.toolsets.length} toolsets, ${report.total} tools`);
  if(process.argv.includes('--crud'))await verifyMcpCrud(bridge,session,report,()=>writeFile(join(stateDir,'catalog.json'),JSON.stringify(report,null,2)));
  report.status='passed';
}catch(error){report.status='failed';report.error={message:error.message,code:error.code,details:error.details};throw error;}
finally{await writeFile(join(stateDir,'catalog.json'),JSON.stringify(report,null,2));child?.kill();await bridge.close();}
