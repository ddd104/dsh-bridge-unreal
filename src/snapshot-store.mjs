// Filesystem and hashing work runs only in the knowledge Worker.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,realpath,stat,copyFile,rename,rm} from 'node:fs/promises';
import {samePath,insidePath} from './project-context.mjs';

export const SNAPSHOT_CAPABILITY='ue_snapshot_export_v1';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,sha1=/^[a-f0-9]{40}$/;
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const hash=bytes=>createHash('sha1').update(bytes).digest('hex');
async function safeFile(file,{optional=false,max=32*1024*1024}={}){
  try{if(!samePath(await realpath(file),path.resolve(file)))fail('SNAPSHOT_BOUNDARY','Linked snapshot/source paths are excluded.');const info=await stat(file);if(!info.isFile()||info.size>max)fail('SNAPSHOT_TOO_LARGE','Snapshot/source file exceeds its limit.');return info;}
  catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
}
async function json(file){await safeFile(file);return JSON.parse(await readFile(file,'utf8'));}
async function fileHash(file){const digest=createHash('sha1');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');}
function packageFile(project,relative){
  if(typeof relative!=='string'||relative.includes('\\')||relative.includes(':')||relative.includes('\0')||relative.split('/').includes('..')||!(/^(Content\/|Plugins\/.+\/Content\/)/.test(relative))||!(/\.(uasset|umap|uexp|ubulk|uptnl)$/i.test(relative)))fail('SNAPSHOT_BOUNDARY','Asset evidence must reference project content packages.');
  const file=path.resolve(project.projectRoot,relative);if(!insidePath(project.projectRoot,file))fail('SNAPSHOT_BOUNDARY','Asset source escaped its project.');return file;
}
async function sourceStatus(project,entry){
  if(!Array.isArray(entry.sourceFiles)||entry.sourceFiles.length<1||entry.sourceFiles.length>4||entry.sourceFiles.some(source=>!source||typeof source.path!=='string')||!entry.sourceFiles.some(source=>source.path===entry.packageFile&&source.exists))fail('SNAPSHOT_INVALID','Missing package source identity.');
  for(const source of entry.sourceFiles){
    const file=packageFile(project,source.path),info=await safeFile(file,{optional:true,max:2*1024**3});
    if(typeof source.exists!=='boolean'||source.exists&&!sha1.test(source.sha1))fail('SNAPSHOT_INVALID','Invalid asset hash.');
    if(!source.exists){if(info)return 'package_changed';continue;}
    if(!info)return 'package_missing';
    if(await fileHash(file)!==source.sha1)return 'package_changed';
  }
  return 'current_on_disk';
}
function validateManifest(project,manifest,generation,editorId){
  if(!manifest||manifest.schemaVersion!==1||manifest.capability!==SNAPSHOT_CAPABILITY||manifest.generation!==generation||!uuid.test(generation)||manifest.evidenceKind!=='saved_package_snapshot'||manifest.scanComplete!==true||typeof manifest.complete!=='boolean'||!Array.isArray(manifest.assets)||manifest.assets.length>50000||!Array.isArray(manifest.excluded)||!Number.isFinite(Date.parse(manifest.capturedAt)))fail('SNAPSHOT_INVALID','Unsupported or incomplete snapshot generation.');
  if(typeof manifest.projectFile!=='string'||!samePath(manifest.projectFile,project.projectFile)||manifest.projectId!==manifest.projectFile||editorId&&manifest.editorId!==editorId)fail('SNAPSHOT_PROJECT_MISMATCH','Snapshot belongs to another project/editor.');
  const seen=new Set();
  for(const entry of manifest.assets){
    if(!entry||typeof entry.assetPath!=='string'||!entry.assetPath.startsWith('/')||entry.assetPath.length>2048||seen.has(entry.assetPath)||!/^assets\/[a-f0-9]{32}\.json$/.test(entry.file)||!sha1.test(entry.sha1)||typeof entry.packageName!=='string'||!Array.isArray(entry.dependencies)||entry.dependencies.length>50000||entry.dependencies.some(value=>typeof value!=='string'||!value.startsWith('/')||value.length>2048))fail('SNAPSHOT_INVALID','Invalid or duplicate asset record.');
    seen.add(entry.assetPath);packageFile(project,entry.packageFile);
  }
}
export async function importSnapshot({project,snapshotRoot,destination,generation,editorId}){
  if(!uuid.test(generation)||typeof editorId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(editorId))fail('SNAPSHOT_INVALID','Invalid snapshot generation/editor.');
  const source=path.resolve(snapshotRoot,'generations',generation);
  if(!insidePath(project.projectRoot,source)||!samePath(await realpath(source),source))fail('SNAPSHOT_BOUNDARY','Snapshot generation must be local to the selected project.');
  const manifest=await json(path.join(source,'manifest.json'));validateManifest(project,manifest,generation,editorId);
  if(hash(await readFile(project.projectFile))!==manifest.descriptorSha1)fail('PROJECT_CHANGED','Snapshot project descriptor is stale.');
  const pointer=await json(path.join(snapshotRoot,'editors',`${editorId}.json`));
  // Explicit imports refer only to the completed producer pointer, never staging.
  const manifestBytes=await readFile(path.join(source,'manifest.json'));
  if(pointer.generation!==generation||pointer.editorId!==editorId||pointer.manifestSha1!==hash(manifestBytes))fail('SNAPSHOT_NOT_PUBLISHED','Export has not published this complete generation.');
  await mkdir(destination,{recursive:true});if(!samePath(await realpath(destination),path.resolve(destination)))fail('SNAPSHOT_BOUNDARY','Snapshot destination follows a link.');
  const stage=path.join(destination,`.import-${randomUUID()}`),target=path.join(destination,generation);
  await mkdir(path.join(stage,'assets'),{recursive:true});let bytes=manifestBytes.length;
  try{
    for(const entry of manifest.assets){
      const file=path.join(source,entry.file),info=await safeFile(file);bytes+=info.size;if(bytes>1024**3)fail('SNAPSHOT_TOO_LARGE','Snapshot import exceeds 1 GiB.');
      if(await fileHash(file)!==entry.sha1)fail('SNAPSHOT_CORRUPT','Asset snapshot hash mismatch.');
      const value=await json(file);
      if(value.assetPath!==entry.assetPath||value.projectId!==manifest.projectFile||value.packageDirty!==false||value.stale!==false||value.fingerprint!==entry.fingerprint)fail('SNAPSHOT_INVALID','Snapshot is not saved project evidence.');
      if(await sourceStatus(project,entry)!=='current_on_disk')fail('SNAPSHOT_STALE','Package changed since export; explicitly export again.');
      await copyFile(file,path.join(stage,entry.file));
      if(await fileHash(path.join(stage,entry.file))!==entry.sha1)fail('SNAPSHOT_CORRUPT','Snapshot changed while copying.');
    }
    if(hash(await readFile(project.projectFile))!==manifest.descriptorSha1)fail('PROJECT_CHANGED','Project changed during import.');
    await writeFile(path.join(stage,'manifest.json'),manifestBytes,{flag:'wx'});
    // Generations are immutable. Same-generation imports are safely idempotent.
    try{await rename(stage,target);}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes(error.code))throw error;await safeFile(path.join(target,'manifest.json'));if(hash(await readFile(path.join(target,'manifest.json')))!==hash(manifestBytes))throw error;for(const entry of manifest.assets){const file=path.join(target,entry.file);await safeFile(file);if(await fileHash(file)!==entry.sha1)fail('SNAPSHOT_CORRUPT','Existing imported generation is damaged; export a new generation.');}}
    return {generation,editorId,manifestSha1:hash(manifestBytes),capturedAt:manifest.capturedAt,assetCount:manifest.assets.length,complete:manifest.complete,excludedCount:manifest.excluded.length,descriptorHash:project.descriptorHash};
  }finally{if(insidePath(destination,stage))await rm(stage,{recursive:true,force:true});}
}
export async function openSnapshot(project,snapshot){
  if(!snapshot)return null;
  const manifestFile=path.join(snapshot.cache,'manifest.json'),manifest=await json(manifestFile);
  validateManifest(project,manifest,snapshot.generation);
  if(hash(await readFile(manifestFile))!==snapshot.manifestSha1)fail('SNAPSHOT_CORRUPT','Published snapshot manifest changed.');
  if(hash(await readFile(project.projectFile))!==manifest.descriptorSha1)fail('SNAPSHOT_STALE','Project descriptor changed.');
  const entries=new Map(manifest.assets.map(entry=>[entry.assetPath,entry])),checks=new Map();
  const find=value=>entries.get(value)??[...entries.values()].find(entry=>entry.packageName===value);
  const verify=async entry=>{if(!checks.has(entry.assetPath))checks.set(entry.assetPath,sourceStatus(project,entry).catch(error=>{if(['ENOENT','EACCES','EPERM'].includes(error.code))return 'source_unavailable';throw error;}));return checks.get(entry.assetPath);};
  return {manifest,entries,find,verify,async read(entry){
    const status=await verify(entry);if(status!=='current_on_disk')fail('SNAPSHOT_STALE',`Asset package is ${status}; export a new snapshot.`);
    const file=path.join(snapshot.cache,entry.file);await safeFile(file);if(await fileHash(file)!==entry.sha1)fail('SNAPSHOT_CORRUPT','Asset snapshot hash mismatch.');
    const value=await json(file);if(value.assetPath!==entry.assetPath||value.packageDirty!==false||value.projectId!==manifest.projectFile)fail('SNAPSHOT_INVALID','Asset snapshot identity changed.');return value;
  }};
}
const metadata=(snapshot,store)=>({snapshotGeneration:snapshot.generation,snapshotEditorId:store.manifest.editorId,snapshotCapturedAt:store.manifest.capturedAt,snapshotCoverage:{complete:store.manifest.complete,assets:store.entries.size,excluded:store.manifest.excluded.length},evidenceKind:'saved_package_snapshot',liveState:'not_verified',authority:'snapshot_evidence',instruction:'Saved-package snapshots are historical editor captures verified against current disk hashes, not live or unsaved state. Missing or excluded assets are not proof of absence.'});
export async function querySnapshot({project,snapshot,tool,args={}}){
  const store=await openSnapshot(project,snapshot);if(!store)fail('SNAPSHOT_MISSING','No imported snapshot. Explicitly export and import one, or use the matching live editor.');
  const offset=args.offset??0,limit=args.limit??64;if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)fail('INVALID_QUERY','offset must be nonnegative; limit must be 1..200.');
  const meta=metadata(snapshot,store);
  if(tool==='graph_query'||tool==='graph_impact'){
    const query=String(args.query??'').trim().toLowerCase();if(tool==='graph_query'&&(!query||query.length>4000))fail('INVALID_QUERY','Graph query must contain 1..4000 characters.');
    const seed=tool==='graph_impact'?store.find(String(args.nodeId??'').replace(/^ueasset:/,'')):null;
    if(tool==='graph_impact'&&!seed)fail('SNAPSHOT_ASSET_MISSING','Snapshot graph node is not covered by this generation.');
    if(seed&&await store.verify(seed)!=='current_on_disk')fail('SNAPSHOT_STALE','Snapshot graph seed package changed.');
    const found=seed?[seed,...[...store.entries.values()].filter(entry=>entry.assetPath!==seed.assetPath&&entry.dependencies.some(target=>target===seed.assetPath||target===seed.packageName))]:[...store.entries.values()].filter(entry=>entry.assetPath.toLowerCase().includes(query)||query.includes(entry.assetPath.toLowerCase()));
    const candidates=[];
    for(const entry of found.slice(0,Math.min(limit,40)))if(await store.verify(entry)==='current_on_disk'){
      await store.read(entry);candidates.push({node:{id:`ueasset:${entry.assetPath}`,name:entry.assetPath.split('/').at(-1),path:entry.assetPath,type:'asset',assetClass:entry.assetClass,sourceStatus:'current_on_disk',snapshotGeneration:snapshot.generation,fingerprint:entry.fingerprint},score:1,reasons:['verified_snapshot_path']});
    }
    return tool==='graph_query'?{...meta,query:args.query,candidates}:{...meta,nodeId:args.nodeId,impacted:candidates.slice(1),depth:1,riskBasis:'One-hop reverse dependencies in the published snapshot; verify live behavior and coverage.'};
  }
  if(tool==='search_asset_snapshots'){
    const query=String(args.query??'').toLowerCase();if(query.length>4000)fail('INVALID_QUERY','Query is too long.');
    const found=[...store.entries.values()].filter(entry=>entry.assetPath.toLowerCase().includes(query));const rows=[];
    for(const entry of found.slice(offset,offset+limit))rows.push({assetPath:entry.assetPath,assetClass:entry.assetClass,fingerprint:entry.fingerprint,coverage:entry.coverage,sourceStatus:await store.verify(entry)});
    return {...meta,assets:rows,total:found.length,nextOffset:offset+rows.length,truncated:offset+rows.length<found.length};
  }
  const entry=store.find(args.assetPath??args.path);if(!entry)fail('SNAPSHOT_ASSET_MISSING','Asset is not covered by this snapshot; inspect coverage or the live editor.');
  const value=await store.read(entry),common={...meta,assetPath:entry.assetPath,assetClass:entry.assetClass,fingerprint:entry.fingerprint,coverage:entry.coverage,sourceStatus:'current_on_disk',dependencies:entry.dependencies.slice(0,200)};
  let items=[];const section=args.section;
  if(!section)return {...common,sections:['properties','blueprint','material','materialInstance'].filter(key=>value[key]!==undefined)};
  if(section==='properties')items=value.properties??[];
  else if(section==='material')items=value.material?.expressions??[];
  else if(section==='materialInstance')items=value.materialInstance?.parameters??[];
  else if(section==='blueprint'){
    const graphs=['functions','eventGraphs','macros','otherGraphs'].flatMap(key=>value.blueprint?.[key]??[]);
    items=args.graph?graphs.find(graph=>graph.name===args.graph||graph.path===args.graph)?.nodes??[]:graphs.map(graph=>({name:graph.name,path:graph.path,graphGuid:graph.graphGuid,graphKind:graph.graphKind,nodeCount:graph.nodes?.length??0}));
  }else if(section==='variables'||section==='components')items=value.blueprint?.[section]??[];
  else fail('INVALID_QUERY','Unsupported snapshot section.');
  const page=[];let length=0;for(const item of items.slice(offset,offset+limit)){const size=JSON.stringify(item).length;if(length+size>64000){if(!page.length)fail('SNAPSHOT_ITEM_TOO_LARGE','This snapshot item requires live bounded inspection.');break;}page.push(item);length+=size;}
  return {...common,section,items:page,total:items.length,nextOffset:offset+page.length,truncated:offset+page.length<items.length};
}
export async function associateSnapshot({project,snapshot,context}){
  if(!snapshot)return {...context,snapshotStatus:{available:false,reason:'snapshot_missing'}};
  const original=context;context=structuredClone(context);
  try{
    const store=await openSnapshot(project,snapshot),links=context.graphAssociations?.links??[],nodes=[],edges=[];
    const candidates=new Set(links.filter(link=>link.kind==='asset').map(link=>link.target));
    for(const match of String(context.query??'').matchAll(/\/(?:Game|[A-Za-z_]\w*)\/[\w/.:-]+/g))candidates.add(match[0]);
    const add=async entry=>{if(!entry||nodes.length>=20)return false;if(nodes.some(node=>node.assetPath===entry.assetPath))return true;if(await store.verify(entry)!=='current_on_disk')return false;await store.read(entry);nodes.push({id:`ueasset:${entry.assetPath}`,assetPath:entry.assetPath,name:entry.assetPath.split('/').at(-1),path:entry.assetPath,type:'asset',assetClass:entry.assetClass,sourceStatus:'current_on_disk',snapshotGeneration:snapshot.generation,fingerprint:entry.fingerprint});return true;};
    for(const target of [...candidates].slice(0,16)){
      const entry=store.find(target),valid=await add(entry);
      for(const link of links.filter(link=>link.kind==='asset'&&link.target===target)){link.status=valid?'resolved_snapshot':entry?'stale_snapshot_asset':'not_in_snapshot';if(valid){link.snapshotGeneration=snapshot.generation;link.nodeIds=[`ueasset:${entry.assetPath}`];}}
      if(valid)for(const dependency of entry.dependencies.slice(0,12)){if(edges.length>=32)break;const related=store.find(dependency);if(await add(related))edges.push({from:`ueasset:${entry.assetPath}`,to:`ueasset:${related.assetPath}`,type:'snapshot_dependency'});}
    }
    return {...context,snapshotStatus:{available:true,...metadata(snapshot,store)},graphAssociations:{...(context.graphAssociations??{}),links,snapshotGeneration:snapshot.generation,assetNodes:nodes,assetEdges:edges}};
  }catch(error){return {...original,snapshotStatus:{available:false,reason:error.code??'snapshot_unavailable'}};}
}
