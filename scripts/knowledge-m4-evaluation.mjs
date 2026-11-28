// Deterministic integration comparison; deliberately uses only a localhost fake
// provider. This measures routing/ranking/citations, not real embedding quality.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {retrievalFixture} from '../test/helpers/retrieval-fixture.mjs';
import {runKnowledgeWorker} from '../src/knowledge-jobs.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),cleanups=[];
const corpus=JSON.parse(await readFile(new URL('../unreal/DSHUnrealBridge/Tools/test/fixtures/knowledge-baseline/questions.json',import.meta.url),'utf8'));
const questions=[...corpus.questions.map(item=>({...item,scored:item.id!=='exact-asset-graph'})),
  {id:'paraphrase-display',category:'paraphrase',query:'车醒了但屏幕不亮',relevantPaths:['ProjectKnowledge/systems/power.md'],scored:true},
  {id:'paraphrase-rendering',category:'paraphrase',query:'画面卡顿',relevantPaths:['ProjectKnowledge/Docs/rendering.md'],scored:true},
];
const report={schemaVersion:1,stage:'M4',evaluatedAt:new Date().toISOString(),node:process.version,corpusVersion:corpus.version,
  scope:'All three variants use project_context against the same published host generation. The 13 M0/M2 queries are unchanged; two paraphrase cases are added. Vectors are fixed by the localhost fixture; no external provider or answer model is used. UE asset graph scoring is deferred to M5. Actual model-input tokens and real-world quality/performance are not measured.',
  tokenEstimator:'UTF-8 bytes as a conservative upper bound; actual model tokens unknown',results:[],summary:{}};
const evidencePaths=result=>[...new Set([...(result.memory?.relevantDocs??[]).map(doc=>doc.path),...(result.sources??[]).map(source=>source.path),...(result.memory?.graphContext?.context?.nodes??[]).map(node=>node.path)])].slice(0,10);
const percentile=(values,q)=>values.toSorted((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*q)-1)];
try{
  const f=await retrievalFixture({after:fn=>cleanups.push(fn)}),p=await f.project();
  // Retain the original baseline prose alongside M4's explicit Wiki links.
  const powerFile=path.join(p.dir,'ProjectKnowledge/systems/power.md');
  await writeFile(powerFile,await readFile(powerFile,'utf8')+'\n\n'+await readFile(new URL('../unreal/DSHUnrealBridge/Tools/test/fixtures/knowledge-baseline/project/ProjectKnowledge/systems/power.md',import.meta.url),'utf8'));
  await f.configure();const built=await f.build(p),current=await f.knowledge.jobs.current(p.context);
  report.documentEmbedding={requests:built.job.embeddingRequests,usage:built.job.usage,chunks:built.index.chunksIndexed};
  const packaged=process.env.DSH_EMBEDDING_TEST_PACKAGE;
  for(const variant of ['legacy','base','hybrid']){
    const callsBefore=f.calls.length;
    for(const item of questions){
      const start=performance.now();
      const result=variant==='legacy'
        ?await runKnowledgeWorker({project:p.context,cache:current.cache,request:{tool:'project_context',arguments:{query:item.query}}},packaged?{workerUrl:pathToFileURL(path.resolve(packaged,'lib/knowledge-worker.js'))}:{})
        :await f.query(p,item.query,variant==='base'?{retrievalMode:'base'}:{});
      const elapsedMs=Math.round(performance.now()-start),paths=evidencePaths(result);
      let checked=0,matched=0;
      for(const doc of result.memory?.relevantDocs??[]){
        if(!doc.chunkId||!doc.sourceHash)continue;checked++;
        const read=await f.knowledge.query(p.agent,{tool:'read_chunk',arguments:{chunkId:doc.chunkId,expectedHash:doc.sourceHash}});
        if(read.path===doc.path&&read.sourceHash===doc.sourceHash)matched++;
      }
      for(const source of result.sources??[]){
        if(!source.hash)continue;checked++;
        const read=await f.knowledge.query(p.agent,{tool:'read_source',arguments:{path:source.path,expectedHash:source.hash,startLine:source.line??1,maxLines:1}});
        if(read.hash===source.hash)matched++;
      }
      assert.equal(matched,checked,`${variant}/${item.id}: citations must round-trip`);
      const row={variant,id:item.id,category:item.category,query:item.query,scored:item.scored,returnedPaths:paths,relevantPaths:item.relevantPaths,
        recallAt10:item.scored&&item.relevantPaths.length?item.relevantPaths.filter(file=>paths.includes(file)).length/item.relevantPaths.length:null,
        ...(item.category==='no-answer'?{noAnswerEvidenceEmpty:paths.length===0}:{}),
        citations:{checked,matched,accuracy:checked?matched/checked:null},elapsedMs,serializedChars:JSON.stringify(result).length,tokenUpperBound:Buffer.byteLength(JSON.stringify(result)),actualModelTokens:null,
        retrievalMode:result.retrievalMode??'legacy',queryEmbedding:result.retrieval?.queryEmbedding??{embeddingRequests:0,cacheHit:false,usage:{}},documentEmbeddingRequests:result.retrieval?.documentEmbeddingRequests??0};
      if(!item.scored)row.exclusion='Host generations have no verified UE asset snapshot until M5; Wiki asset references remain unverified.';
      report.results.push(row);
    }
    const rows=report.results.filter(row=>row.variant===variant),scored=rows.filter(row=>row.recallAt10!==null),times=rows.map(row=>row.elapsedMs);
    report.summary[variant]={queries:rows.length,scoredAnswerQueries:scored.length,meanRecallAt10:scored.reduce((sum,row)=>sum+row.recallAt10,0)/scored.length,
      emptyNoAnswerQueries:rows.filter(row=>row.noAnswerEvidenceEmpty).length,citationsChecked:rows.reduce((sum,row)=>sum+row.citations.checked,0),citationsMatched:rows.reduce((sum,row)=>sum+row.citations.matched,0),
      p50Ms:percentile(times,.5),p95Ms:percentile(times,.95),meanTokenUpperBound:Math.round(rows.reduce((sum,row)=>sum+row.tokenUpperBound,0)/rows.length),actualModelTokens:null,queryRequests:f.calls.length-callsBefore,queryCacheHits:rows.filter(row=>row.queryEmbedding.cacheHit).length,documentEmbeddingRequests:0};
    if(variant!=='hybrid')assert.equal(f.calls.length,callsBefore,'base and legacy must make zero provider calls');
    assert.ok(rows.filter(row=>row.category==='no-answer').every(row=>row.noAnswerEvidenceEmpty));
  }
  for(const item of questions.filter(item=>item.scored&&['symbol','document','asset','mixed'].includes(item.category))){
    const rows=report.results.filter(row=>row.id===item.id);
    assert.ok(rows.find(row=>row.variant==='hybrid').recallAt10>=rows.find(row=>row.variant==='base').recallAt10,`exact retrieval regression: ${item.id}`);
  }
  for(const row of report.results.filter(row=>row.category==='paraphrase'&&row.variant==='hybrid'))assert.equal(row.recallAt10,1);
  assert.equal((await f.knowledge.jobs.current(p.context)).generation,current.generation,'queries must not rebuild documents');
  const output=path.join(root,'.test-state/knowledge-m4/results.json');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,documentEmbedding:report.documentEmbedding,summary:report.summary},null,2));
}finally{for(const cleanup of cleanups.toReversed())await cleanup();}
