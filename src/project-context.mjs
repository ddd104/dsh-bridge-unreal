import path from 'node:path';
import {realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fail} from './protocol.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>process.platform==='win32'?path.normalize(value).toLowerCase():path.normalize(value);
export const samePath=(a,b)=>canonical(a)===canonical(b);
export const insidePath=(root,value)=>{const rel=path.relative(root,value);return rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};
const absent=error=>['ENOENT','ENOTDIR','FS_NOT_FOUND','FS_NOT_DIRECTORY'].includes(error?.code);
const skip=new Set(['.git','.codex','.agents','node_modules','Binaries','Intermediate','Saved','Content','Runtime','Cache','dist']);

/** Both directions must be confirmed by the host filesystem. Never infer WSL mappings. */
export async function localTarget(fs,value,signal) {
  signal?.throwIfAborted();
  if(!fs?.resolve||!fs?.stat||!fs?.listDir||!fs?.processPath||!fs?.processPathFromHostPath)
    fail('PROJECT_LOCAL_UNAVAILABLE','The DSH filesystem cannot verify a local workspace mapping.');
  const target=await fs.resolve(value,{signal});
  const display=target?.displayPath;
  if(typeof display!=='string'||!path.isAbsolute(display)||!samePath(fs.processPath(target)??'',display)||!samePath(fs.processPathFromHostPath(display)??'',display))
    fail('PROJECT_LOCAL_UNAVAILABLE','The workspace does not map to this host; use the bound editor knowledge service.');
  const info=await fs.stat(target,signal);
  signal?.throwIfAborted();
  return {target,info,path:display};
}

/** Shared nearest-project discovery; filesystem authorization applies at each parent. */
export async function nearestProject(fs,cwd,signal) {
  if(typeof cwd!=='string'||!cwd.trim())return undefined;
  let current=cwd;
  while(true){
    let entry;
    try{entry=await localTarget(fs,current,signal);}catch(error){
      if(absent(error)||current!==cwd&&['EACCES','EPERM','FS_PERMISSION_DENIED','FS_SANDBOX_DENIED'].includes(error.code))return undefined;
      throw error;
    }
    if(entry.info?.type!=='directory')return undefined;
    const children=await fs.listDir(entry.target,signal);
    signal?.throwIfAborted();
    const descriptors=children.filter(child=>child.type==='file'&&/\.uproject$/i.test(child.name)).map(child=>path.join(entry.path,child.name)).sort();
    if(descriptors.length)return {...entry,descriptors};
    const parent=path.dirname(entry.path);if(parent===entry.path)return undefined;current=parent;
  }
}

export class ProjectContextResolver {
  constructor({getService,bridge}){this.getService=getService;this.bridge=bridge;this.projects=new Map();this.boundProjects=new Map();}
  async bound(agent,{projectHandle,signal}={}){
    const sessionId=agent?.session?.id,editorId=this.bridge.sessions.get(sessionId),version=this.bridge.bindingVersions.get(sessionId)??0;
    if(!editorId)fail('NOT_BOUND','请先在当前对话的 Unreal Editor 面板绑定 UE 项目。');
    const editor=this.bridge.editors.get(editorId),previous=this.boundProjects.get(sessionId);
    const file=editor?.projectPath??(previous?.editorId===editorId&&previous.version===version?previous.projectFile:null);
    if(!file)fail('DISCONNECTED','绑定的 UE 已离线；请重新连接一次以识别项目。');
    const project=await this.register(file,path.dirname(file),signal);
    if(this.bridge.sessions.get(sessionId)!==editorId||(this.bridge.bindingVersions.get(sessionId)??0)!==version)fail('INSTANCE_CHANGED','UE 绑定已变化，请在当前项目重试。');
    if(projectHandle&&project.projectHandle!==projectHandle)fail('PROJECT_EDITOR_MISMATCH','知识操作的项目与当前绑定的 UE 不一致。');
    this.boundProjects.set(sessionId,{editorId,version,projectFile:project.projectFile});
    return {...project,editorId,bindingVersion:version,connected:!!editor};
  }
  async cwd(agent,signal){
    const service=this.getService('workingDirectory');
    if(!agent||!service?.ensure)fail('PROJECT_LOCAL_UNAVAILABLE','An authorized conversation workspace is required.');
    const cwd=await service.ensure(agent,signal);
    if(typeof cwd!=='string'||!cwd.trim())fail('PROJECT_LOCAL_UNAVAILABLE','The conversation has no workspace.');
    return cwd;
  }
  async register(descriptor,cwd,signal){
    const fs=this.getService('fs');
    const checked=await localTarget(fs,descriptor,signal);
    if(checked.info?.type!=='file')fail('PROJECT_NOT_FOUND','The project descriptor is unavailable.');
    const projectFile=await realpath(checked.path),projectRoot=path.dirname(projectFile);
    if(!samePath(projectRoot,await realpath(path.dirname(checked.path))))fail('PROJECT_ACCESS_DENIED','Linked project descriptors outside the workspace are excluded.');
    // Recheck the canonical path before native indexing is allowed to use it.
    const root=await localTarget(fs,projectRoot,signal);
    if(root.info?.type!=='directory')fail('PROJECT_NOT_FOUND','The project directory is unavailable.');
    const workingCopyId=hash(canonical(projectFile));
    const project={projectId:workingCopyId,workingCopyId,projectHandle:`project-${workingCopyId}`,projectRoot,projectFile,
      name:path.basename(projectFile,path.extname(projectFile)),workspaceHandle:(await localTarget(fs,cwd,signal)).target.targetKey,
      descriptorHash:hash(await readFile(projectFile)),accessScope:projectRoot};
    const previous=this.projects.get(project.projectHandle);
    this.projects.set(project.projectHandle,{...project,workspaces:new Set([...(previous?.workspaces??[]),cwd])});
    return project;
  }
  async discover(agent,signal){
    if(this.bridge.sessions.has(agent?.session?.id))return [await this.bound(agent,{signal})];
    const cwd=await this.cwd(agent,signal),fs=this.getService('fs');
    const nearest=await nearestProject(fs,cwd,signal);
    let descriptors=nearest?.descriptors??[];
    if(!nearest){
      // Bounded discovery in a multi-project workspace. No traversal outside it.
      let visited=0;
      const walk=async(dir,depth)=>{
        if(depth>4||++visited>128)return;
        const checked=await localTarget(fs,dir,signal);
        if(checked.info?.type!=='directory')return;
        if(!samePath(await realpath(checked.path),path.resolve(checked.path)))return;
        const entries=await fs.listDir(checked.target,signal);
        const found=entries.filter(e=>e.type==='file'&&/\.uproject$/i.test(e.name));
        if(found.length){descriptors.push(...found.map(e=>path.join(checked.path,e.name)));return;}
        for(const entry of entries)if(entry.type==='directory'&&!entry.name.startsWith('.')&&!skip.has(entry.name))await walk(path.join(checked.path,entry.name),depth+1);
      };
      await walk(cwd,0);
    }
    return Promise.all(descriptors.map(file=>this.register(file,cwd,signal)));
  }
  async resolve(agent,{projectHandle,signal}={}){
    if(this.bridge.sessions.has(agent?.session?.id))return this.bound(agent,{projectHandle,signal});
    const projects=await this.discover(agent,signal);
    const project=projectHandle?projects.find(p=>p.projectHandle===projectHandle):projects.length===1?projects[0]:undefined;
    if(!project){
      if(projectHandle)fail('PROJECT_ACCESS_DENIED','The selected project is not in this conversation workspace.');
      if(projects.length>1)fail('PROJECT_SELECTION_REQUIRED','Select an explicit projectHandle from knowledgeProjects.',{projects});
      fail('PROJECT_NOT_FOUND','No Unreal project was found in the authorized workspace.');
    }
    await this.verifyBinding(agent.session.id,project,signal);
    return project;
  }
  async verifyBinding(sessionId,project,signal){
    const editor=this.bridge.editors.get(this.bridge.sessions.get(sessionId));
    if(!editor)return;
    let file;
    try{
      const target=await localTarget(this.getService('fs'),editor.projectPath,signal);
      if(target.info?.type==='file'&&/\.uproject$/i.test(target.path))file=await realpath(target.path);
    }catch(error){signal?.throwIfAborted();}
    if(!file||!samePath(file,project.projectFile))fail('PROJECT_EDITOR_MISMATCH','The bound editor project does not match the selected workspace project.',{projectHandle:project.projectHandle,projectFile:project.projectFile,editorId:editor.editorId});
  }
  async resolveHandle(projectHandle,signal){
    const entry=this.projects.get(projectHandle);
    if(!entry)fail('PROJECT_ACCESS_DENIED','Unknown projectHandle; discover the project from an authorized conversation first.');
    // Global operations use registered grants, revalidated on every request.
    for(const cwd of entry.workspaces){
      const workspace=await localTarget(this.getService('fs'),cwd,signal);
      if(workspace.info?.type!=='directory')continue;
      const root=await realpath(workspace.path);
      if(!insidePath(root,entry.projectRoot)&&!insidePath(entry.projectRoot,root))continue;
      const project=await this.register(entry.projectFile,cwd,signal);
      if(project.projectHandle===projectHandle)return project;
    }
    fail('PROJECT_ACCESS_DENIED','The registered project is no longer accessible.');
  }
  async known(signal){
    const result=[];
    for(const handle of [...this.projects.keys()]){
      try{result.push(await this.resolveHandle(handle,signal));}catch(error){signal?.throwIfAborted();}
    }
    return result;
  }
}
