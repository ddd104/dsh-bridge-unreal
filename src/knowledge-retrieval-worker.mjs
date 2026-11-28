// Only imported in the knowledge Worker. No synchronous SQLite on the host.
import path from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {FullTextIndex} from '../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/dist/src/index/fullTextIndex.js';
import {verifyDocumentSource} from '../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/dist/src/commands/readDocument.js';
import {loadProjectConfig} from '../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/dist/src/config/loadProjectConfig.js';
import {PARSER_VERSION} from '../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/dist/src/index/documentChunks.js';
import {exactTerms,fuseDocuments} from './knowledge-retrieval.mjs';
import {samePath,insidePath} from './project-context.mjs';

async function cachePath(file){if(!samePath(await realpath(file),path.resolve(file)))throw Object.assign(Error('Indexed cache follows a link.'),{code:'KNOWLEDGE_CACHE_BOUNDARY'});return file;}
const strings=value=>Array.isArray(value)?value.filter(item=>typeof item==='string').slice(0,12):[];
const publicMetadata=metadata=>Object.fromEntries(['id','title','type','status','aliases','tags','sources','symbols','assets','relatedPages','references','pdf'].filter(key=>metadata?.[key]!==undefined).map(key=>[key,Array.isArray(metadata[key])?metadata[key].slice(0,20):metadata[key]]));

export async function finalizeRetrieval({project,cache,context,semantic=[],core}){
  const warnings=[...(context.warnings??[])],query=context.query,terms=exactTerms(query);
  const loaded=await loadProjectConfig({projectRoot:project.projectRoot,configPath:await cachePath(path.join(cache,'ProjectMemory.project.json')),hostPaths:{projectId:project.projectId,memoryRoot:path.join(cache,'Memory'),graphRoot:path.join(cache,'Graph'),ueCacheRoot:path.join(cache,'NoUESnapshot')}});
  const lexical=[...(context.memory?.relevantDocs??[])],verified=new Map();let index;
  const valid=async hit=>{
    if(!hit.chunkId||!hit.documentId)return {...hit,sourceStatus:'unverified_legacy_index'};
    try{
      if(!verified.has(hit.documentId)){
        const document=index.document(hit.documentId);
        if(!document||document.parserVersion!==PARSER_VERSION)throw Object.assign(Error(),{code:'index_upgrade_required'});
        await verifyDocumentSource(loaded,document);verified.set(hit.documentId,document);
      }
      const document=verified.get(hit.documentId);if(!document)return null;
      const chunk=index.chunk(hit.chunkId);if(!chunk||chunk.documentId!==document.id||hit.sourceHash!==document.hash)return null;
      return {id:chunk.chunkId,chunkId:chunk.chunkId,documentId:document.id,path:document.path,title:document.title,sourceType:document.sourceType,sourceHash:document.hash,sourceStatus:'current',chunkHash:chunk.chunkHash,parserVersion:chunk.parserVersion,headingPath:chunk.headingPath,location:chunk.location,metadata:publicMetadata(document.metadata),excerpt:String(hit.excerpt??chunk.text).slice(0,1200),score:hit.score};
    }catch(error){verified.set(hit.documentId,null);warnings.push(`${hit.path}: ${error.code??'source_unavailable'}`);return null;}
  };
  let docs=[];
  try{
    index=FullTextIndex.open(await cachePath(path.join(cache,'Memory/index/fts.sqlite')));
    for(const term of terms)lexical.push(...index.search(term,20));
    const fulltext=[],vectors=[];
    for(const [hits,dest] of [[lexical,fulltext],[semantic,vectors]])for(const hit of hits.slice(0,120)){const row=await valid(hit);if(row)dest.push(row);}
    docs=fuseDocuments(query,fulltext,vectors);
  }catch(error){warnings.push(`document_index: ${error.code??'unavailable'}`);}
  finally{index?.close();}

  let graph,hashes=new Map();
  try{
    const sourceFile=await cachePath(path.join(cache,'source-index.json'));if((await stat(sourceFile)).size>32*1024*1024)throw Error('oversized');
    const manifest=JSON.parse(await readFile(sourceFile,'utf8'));if(manifest.identity!==project.projectId)throw Error('identity');
    hashes=new Map(manifest.files.map(file=>[file.path.toLowerCase(),file.hash]));
    if(loaded.config.graph.enabled)graph=new DatabaseSync(await cachePath(path.join(cache,'Graph/project_graph.sqlite')),{readOnly:true});
  }catch{warnings.push('source_graph_unavailable');}
  const nodes=new Map(),edges=[],links=[],sources=new Map(),sourceChecks=new Map(),seeds=new Set();
  const source=async(file,{indexed=true}={})=>{
    if(typeof file!=='string'||path.isAbsolute(file)||file.includes('\0')||file.includes(':')||!insidePath(project.projectRoot,path.resolve(project.projectRoot,file)))return null;
    file=file.replaceAll('\\','/');const hash=hashes.get(file.toLowerCase());if(indexed&&!hash)return null;
    const identity=file.toLowerCase()+':'+(indexed?'indexed':'live');if(sourceChecks.has(identity))return sourceChecks.get(identity);
    if(sourceChecks.size>=64)return null;
    const response=await core({tool:'read_source',arguments:{path:file,...(hash?{expectedHash:hash}:{}),maxLines:8}});
    const value=response.isError?null:response.result;
    if(!value)warnings.push(`${file}: ${response.result?.code??'source_unavailable'}`);
    const hit=value?{path:value.path,hash:value.hash,line:value.startLine,snippet:value.content.slice(0,1000),sourceStatus:'current',channel:'source_graph'}:null;
    sourceChecks.set(identity,hit);return hit;
  };
  const addNode=async(row,seed=false)=>{
    if(!row)return false;if(nodes.has(row.id)){if(seed)seeds.add(row.id);return true;}if(nodes.size>=24)return false;
    const evidence=await source(row.path);if(!evidence)return false;
    const metadata=typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata??{};
    nodes.set(row.id,{id:row.id,name:row.name,type:row.type,path:row.path,system:row.system,language:row.language,summary:String(row.summary??'').slice(0,240),metadata:{line:metadata.line??metadata.startLine},sourceHash:evidence.hash,sourceStatus:'current'});
    sources.set(evidence.path,evidence);if(seed)seeds.add(row.id);return true;
  };
  const lookup=(kind,value)=>graph?graph.prepare(kind==='source'?'SELECT * FROM nodes WHERE path = ? COLLATE NOCASE ORDER BY type, id LIMIT 4':'SELECT * FROM nodes WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 4').all(value):[];
  try{
    for(const term of terms)for(const row of [...lookup('symbol',term),...lookup('source',term)])await addNode(row,true);
    for(const doc of docs.filter(doc=>doc.sourceStatus==='current')){
      for(const [field,kind] of [['sources','source'],['symbols','symbol'],['assets','asset']])for(const value of strings(doc.metadata?.[field])){
        if(links.length>=32)break;
        const link={documentId:doc.documentId,chunkId:doc.chunkId,kind,target:value,status:'unresolved',nodeIds:[]};
        if(kind==='asset'){link.status='unverified_asset';link.reason='Requires a matching published UE snapshot or live inspection.';}
        else{
          for(const row of lookup(kind,value))if(await addNode(row,true))link.nodeIds.push(row.id);
          if(link.nodeIds.length)link.status='resolved';
          else if(kind==='source'){
            const evidence=await source(value,{indexed:false});if(evidence){sources.set(evidence.path,evidence);link.status='resolved_source';link.sourceHash=evidence.hash;}else link.status='missing_or_unavailable';
          }else link.status=graph?'missing_or_stale_symbol':'graph_unavailable';
        }
        links.push(link);
      }
    }
    const old=context.memory?.graphContext;
    for(const node of [...(old?.feature?.nodes??[]),...(old?.context?.nodes??[])].slice(0,24))await addNode(node,true);
    if(graph)for(const id of [...seeds].slice(0,16)){
      const adjacent=graph.prepare('SELECT from_id AS "from",to_id AS "to",type FROM edges WHERE from_id=? OR to_id=? ORDER BY type,from_id,to_id LIMIT 16').all(id,id);
      for(const edge of adjacent){if(edges.length>=32)break;const other=edge.from===id?edge.to:edge.from;if(await addNode(graph.prepare('SELECT * FROM nodes WHERE id=?').get(other))&&!edges.some(item=>item.from===edge.from&&item.to===edge.to&&item.type===edge.type))edges.push(edge);}
    }
  }catch{warnings.push('graph_association_failed');}finally{graph?.close();}
  let sourceSearch='indexed';
  if((!docs.length&&!nodes.size)||(terms.length&&!nodes.size)){
    const response=await core({tool:'project_search',arguments:{query,maxResults:12}});sourceSearch='fallback_scan';
    if(!response.isError)for(const hit of response.result.results)sources.set(hit.path,{...hit,sourceStatus:'current',channel:'source_scan'});
  }
  const files=[...sources.keys()].slice(0,12),graphNodes=[...nodes.values()];
  const memory={...(context.memory??{}),relevantDocs:docs,filesToRead:files,blueprintsToRead:[],assetsToInspect:links.filter(link=>link.kind==='asset').map(link=>link.target),summaryAuthority:'unverified_navigation_only',
    graphContext:{status:{available:!!graph,mode:'sqlite',sourceStatus:'verified_candidates_only',warnings:[]},feature:{query,nodes:graphNodes.filter(node=>seeds.has(node.id)).slice(0,16),filesToRead:files,blueprintsToRead:[],assetsToInspect:[],warnings:[]},context:{seedNodes:[...seeds],nodes:graphNodes,edges,filesToRead:files,blueprintsToRead:[],assetsToInspect:[],warnings:[]}}};
  return {...context,memory,sources:[...sources.values()].slice(0,12),warnings:[...new Set(warnings)].slice(0,20),graphAssociations:{generation:path.basename(cache),depth:1,links},sourceSearch,
    instruction:'Only sourceStatus=current citations and source hashes are verified against current bytes. Wiki status is author-provided; other summaries are navigation, not verified facts. Read chunks/source and inspect live UE assets to resolve gaps. Missing retrieval evidence is not proof of absence.'};
}
