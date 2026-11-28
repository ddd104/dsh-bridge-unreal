import {parentPort,workerData} from 'node:worker_threads';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {loadProjectConfig} from '../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/dist/src/config/loadProjectConfig.js';
import {verifyDocumentSource,readIndexedDocument} from '../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/dist/src/commands/readDocument.js';
import {PARSER_VERSION} from '../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/dist/src/index/documentChunks.js';
import {EmbeddingVectorCache,writeVectorIndex,searchVectorIndex,inspectVectorIndex} from './embedding-vector-store.mjs';
import {requestEmbeddings,MAX_BATCH_CHARS} from './embedding-provider.mjs';
import {embeddingError,hashEmbedding} from './embedding-profile.mjs';
import {insidePath,samePath} from './project-context.mjs';
import {embeddingFailure} from './embedding-failures.mjs';

const control=new AbortController();let externallyCancelled=false;parentPort.on('message',message=>{if(message.cancel){externallyCancelled=true;control.abort();}});
const signal=control.signal,progress=value=>parentPort.postMessage({progress:value});
const sourceError=()=>embeddingError('SOURCE_CHANGED','资料在向量任务期间发生变化；旧索引保留，请手动继续或重新生成。');
async function main(){
  const {project,cache,profile,key,roots,vectorCacheFile,action='build',queryVector}=workerData;
  if(!samePath(await realpath(project.projectRoot),project.projectRoot)||hashEmbedding(await readFile(project.projectFile,'utf8'))!==project.descriptorHash)throw sourceError();
  if(action==='inspect'||action==='search')for(const file of ['ProjectMemory.project.json','Memory/index/vector.sqlite','Memory/index/fts.sqlite'])if(!samePath(await realpath(path.join(cache,file)),path.resolve(cache,file)))throw embeddingError('KNOWLEDGE_CACHE_BOUNDARY','向量索引目录不能通过链接重定向。');
  if(action==='inspect')return inspectVectorIndex(path.join(cache,'Memory/index/vector.sqlite'),profile.spaceFingerprint);
  const loaded=await loadProjectConfig({projectRoot:project.projectRoot,configPath:path.join(cache,'ProjectMemory.project.json'),hostPaths:{projectId:project.projectId,memoryRoot:path.join(cache,'Memory'),graphRoot:path.join(cache,'Graph'),ueCacheRoot:path.join(cache,'NoUESnapshot')}});
  if(action==='search'){
    const found=searchVectorIndex(path.join(cache,'Memory/index/vector.sqlite'),queryVector,{spaceFingerprint:profile.spaceFingerprint,limit:workerData.limit});
    const results=[],warnings=[];
    for(const candidate of found.results){try{const chunk=await readIndexedDocument(loaded,'read_chunk',{chunkId:candidate.chunkId,expectedHash:candidate.sourceHash});results.push({...chunk,score:candidate.score,channel:'vector'});}catch(error){warnings.push({path:candidate.path,code:error.code??'source_unavailable'});}}
    return {manifest:found.manifest,results,warnings};
  }
  const documents=[],entries=[],unique=new Map();let totalChars=0;
  const stream=createReadStream(path.join(cache,'Memory/index/documents.jsonl'),{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
  try{for await(const line of lines){
    signal.throwIfAborted();if(!line.trim())continue;
    const {chunks,text:_text,...document}=JSON.parse(line);
    if(document.parserVersion!==PARSER_VERSION||!Array.isArray(chunks))throw embeddingError('EMBEDDING_INDEX_UPGRADE','请先更新支持文档片段的基础索引。');
    await verifyDocumentSource(loaded,document);documents.push(document);
    if(!roots.some(root=>insidePath(path.resolve(project.projectRoot,root),path.resolve(project.projectRoot,document.path))))continue;
    for(const chunk of chunks){
      const input=`Title: ${document.title}\nSection: ${chunk.headingPath.join(' / ')}\n\n${chunk.text}`;
      if(input.length>profile.maxInputChars)throw embeddingError('EMBEDDING_INPUT_TOO_LARGE','有片段超出输入上限，请缩小工程分块或调整模型允许的输入上限。');
      const inputHash=hashEmbedding(input);if(!unique.has(inputHash)){unique.set(inputHash,{input,inputHash});totalChars+=input.length;}
      entries.push({chunkId:chunk.chunkId,documentId:document.id,path:document.path,sourceHash:document.hash,inputHash});
      if(entries.length>50000||totalChars>64*1024*1024)throw embeddingError('EMBEDDING_SCOPE_TOO_LARGE','首版单任务最多 50000 个片段、64 Mi 字符；请缩小资料范围。');
    }
  }}finally{lines.close();stream.destroy();}
  signal.throwIfAborted();await mkdir(path.dirname(vectorCacheFile),{recursive:true});
  const vectors=new EmbeddingVectorCache(vectorCacheFile);
  try{
    const missing=[...unique.values()].filter(item=>!vectors.get(profile.spaceFingerprint,item.inputHash));
    const metrics={documentsIndexed:new Set(entries.map(entry=>entry.documentId)).size,chunksIndexed:entries.length,uniqueInputs:unique.size,cachedInputs:unique.size-missing.length,completedInputs:unique.size-missing.length,embeddingRequests:0,failedInputs:0,cacheRecovered:!!vectors.recovered,usage:{}};
    const batches=[];let batch=[],size=0;
    for(const item of missing){if(batch.length&&(batch.length>=profile.batchSize||size+item.input.length>MAX_BATCH_CHARS)){batches.push(batch);batch=[];size=0;}batch.push(item);size+=item.input.length;}if(batch.length)batches.push(batch);
    progress({phase:'embedding',...metrics});let cursor=0;
    const run=async()=>{while(cursor<batches.length){
      signal.throwIfAborted();const batch=batches[cursor++];
      try{
        const result=await requestEmbeddings(profile,key,batch.map(item=>item.input),{signal,expectedDimension:vectors.dimensions(profile.spaceFingerprint)||profile.dimensions,onAttempt:()=>{
          signal.throwIfAborted();if(metrics.embeddingRequests>=profile.maxRequests)throw embeddingError('EMBEDDING_REQUEST_LIMIT','已达到本次请求次数上限；成功批次已保留，请手动继续。');metrics.embeddingRequests++;progress({phase:'embedding',...metrics});
        }});
        vectors.put(profile.spaceFingerprint,batch,result.vectors,result.dimensions);
        metrics.completedInputs+=batch.length;for(const [name,value] of Object.entries(result.usage))metrics.usage[name]=(metrics.usage[name]??0)+value;
        progress({phase:'embedding',...metrics});
      }catch(error){metrics.failedInputs+=batch.length;progress({phase:'embedding',...metrics});throw error;}
    }};
    // Observe every branch before closing SQLite, even if one request fails first.
    let failure;await Promise.all(Array.from({length:Math.min(profile.concurrency,batches.length)},async()=>{try{await run();}catch(error){failure??=embeddingFailure(error,{cancelled:externallyCancelled});control.abort();}}));if(failure)throw failure;
    signal.throwIfAborted();progress({phase:'verifying_vectors',...metrics});
    for(const document of documents){signal.throwIfAborted();await verifyDocumentSource(loaded,document);}
    if(hashEmbedding(await readFile(project.projectFile,'utf8'))!==project.descriptorHash)throw sourceError();
    const dimensions=vectors.dimensions(profile.spaceFingerprint)||profile.dimensions;
    const manifest={schemaVersion:1,projectId:project.projectId,descriptorHash:project.descriptorHash,generation:path.basename(cache),spaceFingerprint:profile.spaceFingerprint,profileFingerprint:hashEmbedding([profile.spaceFingerprint,dimensions]),profileId:profile.profileId,provider:profile.provider,endpoint:profile.endpoint,model:profile.model,dimensions,inputVersion:profile.inputVersion,normalization:profile.normalization,parserVersion:PARSER_VERSION,roots,createdAt:new Date().toISOString(),coverage:entries.length?1:0,...metrics};
    writeVectorIndex(path.join(cache,'Memory/index/vector.sqlite'),manifest,entries,vectors);
    await writeFile(path.join(cache,'vector-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    return manifest;
  }finally{vectors.close();}
}
try{const result=await main();parentPort.postMessage({response:{isError:false,result}});}
catch(error){parentPort.postMessage({response:{isError:true,result:embeddingFailure(error,{cancelled:externallyCancelled})}});}
finally{parentPort.close();}
