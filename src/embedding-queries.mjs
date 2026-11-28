import {requestEmbeddings} from './embedding-provider.mjs';
import {hashEmbedding,embeddingError,requireProfileRevision} from './embedding-profile.mjs';

// Short-lived, project/space-isolated query cache. Only hashed keys and vectors
// are retained. Nothing is persisted and restart never submits a query.
export class EmbeddingQueries {
  constructor(service){this.service=service;this.epoch=0;this.cache=new Map();this.pending=new Map();this.cooldowns=new Map();this.totals={requests:0,cacheHits:0,shared:0,usage:{}};}
  invalidate(){this.epoch++;for(const entry of this.pending.values())entry.control.abort();this.cache.clear();this.cooldowns.clear();}
  async retrieve({project,current,query,signal,verify}){
    const started=performance.now(),metrics={embeddingRequests:0,cacheHit:false,shared:false,usage:{}};
    const base=reason=>({results:[],warnings:[],retrievalMode:'base',degradedReasons:[reason],metrics:{...metrics,elapsedMs:Math.round(performance.now()-started)}});
    let profile,deadline,workSignal=signal;const epoch=this.epoch;
    const assertCurrent=()=>{requireProfileRevision(this.service.profile(true),profile.configFingerprint);if(epoch!==this.epoch)throw embeddingError('EMBEDDING_CREDENTIAL_CHANGED','查询期间配置或凭据发生变化。');};
    try{
      profile=this.service.profile(true);
      deadline=AbortSignal.timeout(10000);workSignal=signal?AbortSignal.any([signal,deadline]):deadline;
      const found=await this.service.jobs.current(project,current);
      if(!found)return base('vector_index_missing');
      const {manifest}=found;
      if(manifest.spaceFingerprint!==profile.spaceFingerprint)return base('vector_space_changed');
      if(!manifest.chunksIndexed||!manifest.dimensions)return base('vector_index_empty');
      const cooldown=this.cooldowns.get(profile.configFingerprint);if(cooldown&&cooldown.until>Date.now())return base(cooldown.code);
      const key=await this.service.credentials.read(profile);await verify();
      assertCurrent();workSignal.throwIfAborted();
      const input=query.normalize('NFC').trim();
      if(!input||input.length>Math.min(profile.maxInputChars,4000))return base('query_input_too_large');
      // Inspect this pinned generation before a billable request; never reopen
      // current.json midway through a query when another build publishes.
      const inspect=await this.service.jobs.runVector({action:'inspect',project,cache:current.cache,profile},{signal:workSignal});
      if(inspect.manifest.profileFingerprint!==manifest.profileFingerprint)throw embeddingError('EMBEDDING_INDEX_INVALID','向量索引版本不一致。');
      await verify();assertCurrent();workSignal.throwIfAborted();
      const cacheKey=hashEmbedding([project.projectId,manifest.profileFingerprint,'plain-query-v1',input]);
      let vector,cached=this.cache.get(cacheKey);
      if(cached&&cached.expires>Date.now()){vector=cached.vector;metrics.cacheHit=true;this.totals.cacheHits++;this.cache.delete(cacheKey);this.cache.set(cacheKey,cached);}
      else{
        this.cache.delete(cacheKey);
        let entry=this.pending.get(cacheKey);
        if(entry){metrics.shared=true;this.totals.shared++;}
        else{
          if(this.pending.size>=2)return base('query_embedding_busy');
          entry={control:new AbortController(),users:new Set()};
          entry.promise=(async()=>{
            try{
              const response=await requestEmbeddings({...profile,timeoutMs:Math.min(profile.timeoutMs,5000)},key,[input],{signal:entry.control.signal,expectedDimension:manifest.dimensions,maxRetries:0,fetchImpl:this.service.fetchImpl,onAttempt:()=>{assertCurrent();metrics.embeddingRequests++;this.totals.requests++;}});
              entry.control.signal.throwIfAborted();assertCurrent();
              for(const [name,count] of Object.entries(response.usage)){metrics.usage[name]=count;this.totals.usage[name]=(this.totals.usage[name]??0)+count;}
              this.cache.set(cacheKey,{vector:response.vectors[0],expires:Date.now()+300000});if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);
              return response.vectors[0];
            }catch(error){if(!entry.control.signal.aborted)this.cooldowns.set(profile.configFingerprint,{code:error.code??'EMBEDDING_QUERY_FAILED',until:Date.now()+30000});throw error;}
            finally{if(this.pending.get(cacheKey)===entry)this.pending.delete(cacheKey);}
          })();
          this.pending.set(cacheKey,entry);
        }
        const user={};entry.users.add(user);
        let abort;
        const cancelled=new Promise((_,reject)=>{abort=()=>{entry.users.delete(user);if(!entry.users.size)entry.control.abort();reject(workSignal.reason??embeddingError('CANCELLED','查询已取消。'));};workSignal.addEventListener('abort',abort,{once:true});if(workSignal.aborted)abort();});
        try{vector=await Promise.race([entry.promise,cancelled]);}finally{workSignal.removeEventListener('abort',abort);entry.users.delete(user);}
      }
      await verify();assertCurrent();workSignal.throwIfAborted();
      const result=await this.service.jobs.runVector({action:'search',project,cache:current.cache,profile,queryVector:vector,limit:40},{signal:workSignal});
      await verify();assertCurrent();workSignal.throwIfAborted();
      const results=result.results.filter(hit=>hit.score>=0.35).slice(0,20);
      return {results,warnings:result.warnings,retrievalMode:results.length?'hybrid':'base',degradedReasons:results.length?[]:['no_valid_vector_hits'],profileFingerprint:manifest.profileFingerprint,metrics:{...metrics,elapsedMs:Math.round(performance.now()-started)}};
    }catch(error){signal?.throwIfAborted();return base(deadline?.aborted?'EMBEDDING_QUERY_TIMEOUT':typeof error.code==='string'?error.code:'EMBEDDING_QUERY_FAILED');}
  }
  async dispose(){this.invalidate();await Promise.allSettled([...this.pending.values()].map(entry=>entry.promise));}
}
