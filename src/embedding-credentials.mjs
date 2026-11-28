import path from 'node:path';
import {mkdir,readFile,writeFile,rename,rm,realpath,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {samePath} from './project-context.mjs';
import {hashEmbedding,embeddingError} from './embedding-profile.mjs';

const keyPattern=/^[\x21-\x7e]{1,4096}$/;
export function validateEmbeddingKey(value){
  if(typeof value!=='string'||!keyPattern.test(value.trim()))throw embeddingError('EMBEDDING_KEY_INVALID','API Key 必须是非空的单行可打印字符，不能包含空格。');
  return value.trim();
}
export const embeddingCredentialId=profile=>`unreal-bridge/embedding-${hashEmbedding([profile.profileId,profile.endpoint]).slice(0,32)}`;
const available=service=>['readRecord','describeRecord','modifyRecord','deleteRecord'].every(key=>typeof service?.[key]==='function');
async function checkedPath(file){
  let parent=file;
  for(;;){try{if(!samePath(await realpath(parent),path.resolve(parent)))throw embeddingError('EMBEDDING_CREDENTIAL_BOUNDARY','凭据目录不能通过链接重定向。');return;}
    catch(error){if(error.code!=='ENOENT')throw error;const next=path.dirname(parent);if(next===parent)throw error;parent=next;}}
}

// Fixed code, hidden helper, secret only on stdin. No shell interpolation or key in argv.
export function windowsProtect(operation,value){
  if(process.platform!=='win32')throw embeddingError('EMBEDDING_CREDENTIAL_UNAVAILABLE','当前宿主缺少凭据存储，请使用提供 credentials 服务的 DSH。');
  const script='$ErrorActionPreference = "Stop"; try { Add-Type -AssemblyName System.Security; $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json; if ($payload.operation -eq "protect") { $raw = [Text.Encoding]::UTF8.GetBytes($payload.value); $encrypted = [Security.Cryptography.ProtectedData]::Protect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($encrypted)); } else { $encrypted = [Convert]::FromBase64String($payload.value); $raw = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($raw)); } } catch { exit 1 }';
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const error=()=>embeddingError('EMBEDDING_CREDENTIAL_FAILED','Windows 用户凭据保护操作失败。');
    const timer=setTimeout(()=>{child.kill();finish(error());},10000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>32768){child.kill();finish(error());}});child.stderr.resume();
    child.on('error',()=>finish(error()));child.on('exit',code=>finish(code===0?null:error(),output));child.stdin.on('error',()=>finish(error()));child.stdin.end(JSON.stringify({operation,value}));
  });
}

export class EmbeddingCredentials {
  constructor({stateDir,getService,protect=windowsProtect}){this.root=path.resolve(stateDir,'EmbeddingCredentials');this.getService=getService;this.protect=protect;}
  file(profile){return path.join(this.root,embeddingCredentialId(profile).split('/')[1]+'.json');}
  async guarded(action){try{return await action();}catch(error){if(typeof error?.code==='string'&&error.code.startsWith('EMBEDDING_'))throw error;throw embeddingError('EMBEDDING_CREDENTIAL_FAILED','凭据存储不可用；密钥未返回到设置或日志。');}}
  async describe(profile){return this.guarded(async()=>{
    const service=this.getService('credentials');
    const info=available(service)?await service.describeRecord(embeddingCredentialId(profile)):null;
    if(info?.configured)return {credentialConfigured:true,credentialWritable:info.writable!==false,credentialBackend:'dsh_credentials'};
    const file=this.file(profile);await checkedPath(file);let stored=false;try{stored=(await stat(file)).isFile();}catch(error){if(error.code!=='ENOENT')throw error;}
    return {credentialConfigured:stored,credentialWritable:info?info.writable!==false:process.platform==='win32',credentialBackend:stored?'windows_dpapi':info?'dsh_credentials':process.platform==='win32'?'windows_dpapi':'unavailable'};
  });}
  async read(profile){return this.guarded(async()=>{
    const service=this.getService('credentials');
    if(available(service)){const record=await service.readRecord(embeddingCredentialId(profile));if(record){if(record.kind!=='api-key')throw embeddingError('EMBEDDING_KEY_INVALID','凭据记录类型不支持。');return validateEmbeddingKey(record.key);}}
    const file=this.file(profile);await checkedPath(file);let record;
    try{record=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')throw embeddingError('EMBEDDING_KEY_MISSING','请先保存此服务的 API Key。');throw error;}
    if(record.version!==1||record.credentialId!==embeddingCredentialId(profile)||typeof record.protected!=='string')throw new Error('invalid credential envelope');
    return validateEmbeddingKey(await this.protect('unprotect',record.protected));
  });}
  async set(profile,value){return this.guarded(async()=>{
    const key=validateEmbeddingKey(value),service=this.getService('credentials'),file=this.file(profile);await checkedPath(file);
    if(available(service)){
      await service.modifyRecord(embeddingCredentialId(profile),async()=>({kind:'api-key',key}));await rm(file,{force:true});
    }else{
      const protectedValue=await this.protect('protect',key);await mkdir(this.root,{recursive:true,mode:0o700});await checkedPath(file);
      const temp=`${file}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify({version:1,credentialId:embeddingCredentialId(profile),protected:protectedValue}),{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await rm(temp,{force:true});}
    }
    return this.describe(profile);
  });}
  async remove(profile){return this.guarded(async()=>{
    const service=this.getService('credentials');if(available(service))await service.deleteRecord(embeddingCredentialId(profile));
    const file=this.file(profile);await checkedPath(file);await rm(file,{force:true});return this.describe(profile);
  });}
}
