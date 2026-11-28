// Host-side ranking and bounded context assembly. Scores from different
// retrieval channels are deliberately never added; only ranks are fused.
export const RETRIEVAL_DEFAULTS=Object.freeze({maxTokens:12000,maxChars:24000,maxDocs:10,maxPerDocument:2});
export function exactTerms(query){
  const words=String(query).match(/(?:\/?[A-Za-z_][\w.-]*[\\/][\w./\\-]+)|[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/g)??[];
  return [...new Set(words.filter(word=>/[\\/_:]|[a-z][A-Z]|^[UAFISTE][A-Z]/.test(word)).map(word=>word.replaceAll('\\','/')))].slice(0,16);
}
export function exactMatch(hit,query){
  const text=[hit.path,hit.title,...(hit.headingPath??[]),hit.excerpt,...['aliases','symbols','assets','sources'].flatMap(key=>Array.isArray(hit.metadata?.[key])?hit.metadata[key]:[])].filter(Boolean).join('\n');
  const full=String(query).trim().toLowerCase();
  if([hit.path,hit.title,...(hit.metadata?.aliases??[])].some(value=>typeof value==='string'&&value.toLowerCase()===full))return true;
  return exactTerms(query).some(term=>new RegExp(`(^|[^\\w])${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}($|[^\\w])`,'i').test(text));
}
export function fuseDocuments(query,lexical=[],semantic=[],{maxDocs=10,maxPerDocument=2}={}){
  const candidates=new Map();
  for(const [channel,hits] of [['fulltext',lexical],['vector',semantic]]){
    const seen=new Set();
    hits.forEach((hit,index)=>{
      const id=hit.chunkId??hit.id;if(!id||seen.has(id))return;seen.add(id);
      let row=candidates.get(id);if(!row){row={...hit,id,excerpt:hit.excerpt??hit.content??hit.text??'',channels:[],ranks:{},channelScores:{},score:0,exactMatch:exactMatch(hit,query)};candidates.set(id,row);}
      row.channels.push(channel);row.ranks[channel]=index+1;row.channelScores[channel]=hit.score;row.score+=1/(60+index+1);
    });
  }
  const ordered=[...candidates.values()].sort((a,b)=>Number(b.exactMatch)-Number(a.exactMatch)||b.score-a.score||a.id.localeCompare(b.id)),counts=new Map(),result=[];
  for(const row of ordered){const doc=row.documentId??row.path;if((counts.get(doc)??0)>=maxPerDocument)continue;counts.set(doc,(counts.get(doc)??0)+1);result.push(row);if(result.length>=maxDocs)break;}
  return result;
}
const size=value=>{const json=JSON.stringify(value);return {characters:json.length,estimatedTokens:Buffer.byteLength(json,'utf8')};};
export function boundContext(value,options={}){
  const maxTokens=Math.max(2048,Math.min(64000,options.maxTokens??RETRIEVAL_DEFAULTS.maxTokens)),maxChars=Math.max(2048,Math.min(128000,options.maxChars??RETRIEVAL_DEFAULTS.maxChars));
  const result=structuredClone(value),stats={maxTokens,maxChars,tokenEstimator:'utf8-byte-upper-bound',truncated:false,omittedItems:0};
  result.contextBudget=stats;
  const fits=()=>{Object.assign(stats,size(result));return stats.estimatedTokens+32<=maxTokens&&stats.characters+32<=maxChars;};
  // Trim navigation summaries before verified citations. Keep whole citation
  // objects, so offsets and hashes never describe an invented excerpt range.
  const memory=result.memory;
  if(memory){
    for(const key of ['projectCapsule','owningSystem','secondarySystems','architectureRules','relevantImplementations','existingPatterns','reusableSymbols','reusableBlueprints','reusableAssets','forbiddenApproaches','extensionGuidance','validationPlan','missingInformation']){
      if(fits())break;
      const old=memory[key];if(old&&JSON.stringify(old).length>2){memory[key]=Array.isArray(old)?[]:typeof old==='string'?'':{confidence:'none',sourcePaths:[],evidence:[]};stats.truncated=true;stats.omittedItems++;}
    }
    if(!fits()&&memory.graphContext){memory.graphContext={status:memory.graphContext.status,feature:{nodes:[]},context:{nodes:[],edges:[]}};stats.truncated=true;stats.omittedItems++;}
  }
  const arrays=[result.warnings,result.retrieval?.sourceWarnings,result.remembered,memory?.assetsToInspect,memory?.blueprintsToRead,memory?.filesToRead,result.graphAssociations?.links,result.graphAssociations?.assetEdges,result.graphAssociations?.assetNodes,result.graphAssociations?.edges,result.graphAssociations?.nodes,result.sources,memory?.relevantDocs];
  for(const list of arrays){if(!Array.isArray(list))continue;while(list.length&&!fits()){list.pop();stats.truncated=true;stats.omittedItems++;}}
  if(!fits()){
    // Extremely verbose legacy packs must still honor the total envelope bound.
    const keep=['query','memory','sources','warnings','authority','instruction','retrievalMode','degradedReasons','indexGeneration','profileFingerprint','projectId','projectHandle','knowledgeBackend','assetEvidenceBackend','retrieval','contextBudget'];
    for(const key of Object.keys(result))if(!keep.includes(key))delete result[key];
    if(memory)result.memory={relevantDocs:memory.relevantDocs??[],filesToRead:[],missingInformation:['Context budget reached; read cited chunks separately.']};
    result.query=String(result.query??'').slice(0,128);result.warnings=[];stats.truncated=true;
  }
  const documentIds=new Set(result.memory?.relevantDocs?.map(doc=>doc.documentId)??[]),nodeIds=new Set([...(result.memory?.graphContext?.context?.nodes??[]),...(result.graphAssociations?.assetNodes??[])].map(node=>node.id));
  if(result.graphAssociations?.assetEdges)result.graphAssociations.assetEdges=result.graphAssociations.assetEdges.filter(edge=>nodeIds.has(edge.from)&&nodeIds.has(edge.to));
  if(result.graphAssociations?.links)result.graphAssociations.links=result.graphAssociations.links.filter(link=>documentIds.has(link.documentId)).map(link=>({...link,nodeIds:link.nodeIds.filter(id=>nodeIds.has(id)),...(link.nodeIds.length&&!link.nodeIds.some(id=>nodeIds.has(id))?{status:'resolved_context_trimmed'}:{})}));
  if(result.retrievalMode==='hybrid'&&!result.memory?.relevantDocs?.some(doc=>doc.channels?.includes('vector')))result.retrievalMode='base';
  if(!fits()){
    // Unknown legacy fields and provider metadata can themselves exceed the
    // minimum budget. Return a small, explicit no-evidence envelope in that case.
    const identity=Object.fromEntries(['indexGeneration','profileFingerprint','projectId','projectHandle','knowledgeBackend','assetEvidenceBackend'].filter(key=>typeof result[key]==='string').map(key=>[key,result[key].slice(0,64)]));
    const query=String(result.query??'').slice(0,128);
    const metrics=result.retrieval?.queryEmbedding;
    for(const key of Object.keys(result))delete result[key];
    Object.assign(result,{...identity,query,memory:null,sources:[],warnings:['Context budget reached; narrow the query or read sources separately.'],authority:'navigation_and_evidence_only',retrievalMode:'base',degradedReasons:['context_budget_exceeded'],contextBudget:stats});
    if(metrics)result.retrieval={documentEmbeddingRequests:0,queryEmbedding:{embeddingRequests:Number.isFinite(metrics.embeddingRequests)?metrics.embeddingRequests:0,cacheHit:metrics.cacheHit===true,shared:metrics.shared===true}};
    stats.truncated=true;stats.omittedItems++;
    // Even arbitrary non-ASCII identifiers must fit the smallest allowed cap.
    for(const key of [...Object.keys(identity),'query']){if(fits())break;delete result[key];}
  }
  Object.assign(stats,size(result));Object.assign(stats,size(result));return result;
}
