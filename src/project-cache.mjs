import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat,realpath,readdir,readFile,mkdir,open,cp,rename,rm,writeFile} from 'node:fs/promises';
import {samePath,insidePath} from './project-context.mjs';
import {fail} from './protocol.mjs';

export const projectCacheRoot=project=>path.join(project.projectRoot,'Plugins','DSHUnrealBridge','Cache','Knowledge',project.projectId);
export const projectKnowledgeRoot=project=>path.join(project.projectRoot,'ProjectKnowledge');
const exists=async file=>{try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};

// A path inside the project must never follow a junction into another project.
export async function checkCachePath(file){
  let current=path.resolve(file);
  for(;;){
    const info=await exists(current);
    if(info&&(info.isSymbolicLink()||!samePath(await realpath(current),current)))fail('KNOWLEDGE_CACHE_BOUNDARY','Knowledge cache cannot follow a linked directory.');
    const parent=path.dirname(current);if(parent===current)return;current=parent;
  }
}

export class ProjectCacheMigration {
  constructor(stateDir){this.legacy=path.resolve(stateDir,'Knowledge');this.pending=new Map();}
  async ensure(project){
    const target=projectCacheRoot(project);
    await checkCachePath(target);
    if(await exists(target))return;
    const source=path.join(this.legacy,project.projectId);
    if(!await exists(source))return;
    let pending=this.pending.get(project.projectId);
    if(!pending){pending=this.copy(project,source,target);this.pending.set(project.projectId,pending);}
    try{await pending;}finally{if(this.pending.get(project.projectId)===pending)this.pending.delete(project.projectId);}
  }
  async copy(project,source,target){
    await checkCachePath(source);
    const sourceLock=path.join(source,'build.lock');
    let lock;
    try{lock=await open(sourceLock,'wx');}
    catch(error){if(error.code==='EEXIST')fail('KNOWLEDGE_BUSY','An old knowledge task owns this cache. Finish it before migrating.');throw error;}
    const parent=path.dirname(target),stage=path.join(parent,`.migration-${project.projectId}-${randomUUID()}`);
    try{
      await lock.writeFile(JSON.stringify({pid:process.pid,migration:true}));
      const inspect=async dir=>{
        for(const entry of await readdir(dir,{withFileTypes:true})){
          const file=path.join(dir,entry.name);if(file===sourceLock)continue;
          if(entry.isSymbolicLink()||!samePath(await realpath(file),file))fail('KNOWLEDGE_CACHE_BOUNDARY','Legacy cache contains a linked path.');
          if(entry.name.endsWith('.lock'))fail('KNOWLEDGE_BUSY','Legacy cache has an unfinished publication; migration has not changed it.');
          if(entry.isDirectory())await inspect(file);
          else if(!entry.isFile())fail('KNOWLEDGE_CACHE_BOUNDARY','Legacy cache contains an unsupported file.');
        }
      };
      await inspect(source);
      const pointer=await exists(path.join(source,'current.json'))?JSON.parse(await readFile(path.join(source,'current.json'),'utf8')):null;
      if(pointer&&pointer.projectId!==project.projectId)fail('KNOWLEDGE_INDEX_INVALID','Legacy cache belongs to another project.');
      await checkCachePath(parent);await mkdir(parent,{recursive:true});
      if(await exists(target))return;
      await cp(source,stage,{recursive:true,filter:file=>file!==sourceLock,errorOnExist:true,force:false});
      await writeFile(path.join(stage,'migration.json'),JSON.stringify({from:source,projectId:project.projectId,migratedAt:new Date().toISOString()}));
      await checkCachePath(parent);
      try{await rename(stage,target);}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code)||!await exists(target))throw error;}
    }finally{
      await lock.close();await rm(sourceLock,{force:true});
      if(insidePath(parent,stage)&&path.dirname(stage)===parent&&await exists(stage)){await checkCachePath(stage);await rm(stage,{recursive:true,force:true});}
    }
  }
}
