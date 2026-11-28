import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createKnowledgeCore} from './knowledge-core.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fail(code,message){throw Object.assign(new Error(message),{code});}
function inside(root,candidate){const rel=path.relative(root,candidate);return rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}

export async function createWorker(projectPath, pluginPath) {
  const project = await realpath(path.resolve(projectPath));
  const plugin = await realpath(path.resolve(pluginPath));
  if (!inside(path.join(project,'Plugins'),plugin)) fail('invalid_plugin','Plugin must be inside the current project Plugins directory.');
  const cache = path.join(plugin,'Cache');
  await mkdir(cache,{recursive:true});
  if (!inside(plugin,await realpath(cache))) fail('invalid_cache','Cache resolves outside the plugin.');
  const descriptor = (await readdir(project)).find(name => name.endsWith('.uproject'));
  if (!descriptor) fail('invalid_project','The project directory has no .uproject descriptor.');
  const identity = sha(`${project.toLowerCase()}\n${descriptor}\n${await readFile(path.join(project,descriptor),'utf8')}`);
  const configPath = path.join(plugin,'Config/Knowledge/ProjectMemory.project.json');

  return createKnowledgeCore({project,plugin,cache,descriptor,identity,configPath});
}

// JSONL stdout 只传协议消息；--once 供 UE 每次启动一个可取消的隐藏进程。
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
  try {
    const worker=await createWorker(arg('--project')??process.cwd(),arg('--plugin')??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
    const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
    for await(const line of lines) {
      if(!line.trim())continue;
      let response;try{if(line.length>65536)fail('request_too_large','Request exceeds 64 KiB.');response=await worker(JSON.parse(line));}catch(error){response={id:null,isError:true,result:{code:error.code??'invalid_request',message:error.message}};}
      process.stdout.write(JSON.stringify(response)+'\n');
      if(process.argv.includes('--once')){lines.close();break;}
    }
  } catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
