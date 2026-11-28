import {setTimeout as delay} from 'node:timers/promises';
import {embeddingError} from './embedding-profile.mjs';
import {validateEmbeddingKey} from './embedding-credentials.mjs';
import {providerFailure,validateEmbeddingBatch} from './embedding-provider-errors.mjs';

export const CONNECTION_TEST_TEXT='DSH Unreal Bridge embedding connection test.';
export const MAX_BATCH_CHARS=128000;
const retryableStatus=new Set([429,500,502,503,504]);
const fail=(code,message)=>{throw embeddingError(code,message);};
export function validateVectors(payload,count,expectedDimension=0){
  if(!payload||!Array.isArray(payload.data)||payload.data.length!==count)fail('EMBEDDING_RESPONSE_INVALID','服务返回的向量数量不匹配。');
  const vectors=Array(count),seen=new Set();let dimensions=expectedDimension;
  for(const item of payload.data){
    if(!Number.isInteger(item.index)||item.index<0||item.index>=count||seen.has(item.index)||!Array.isArray(item.embedding))fail('EMBEDDING_RESPONSE_INVALID','服务返回的向量顺序映射无效。');
    const vector=item.embedding;
    dimensions ||= vector.length;
    if(dimensions<1||dimensions>8192||vector.length!==dimensions||vector.some(value=>typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e20))fail('EMBEDDING_DIMENSION_MISMATCH','服务返回了不兼容的维度或无效数值；请检查模型与输出维度。');
    const norm=Math.hypot(...vector);if(!Number.isFinite(norm)||norm===0)fail('EMBEDDING_RESPONSE_INVALID','服务返回的向量不能归一化。');
    vectors[item.index]=Float32Array.from(vector,value=>value/norm);seen.add(item.index);
  }
  const usage={};
  for(const name of ['prompt_tokens','total_tokens'])if(Number.isSafeInteger(payload.usage?.[name])&&payload.usage[name]>=0)usage[name]=payload.usage[name];
  return {vectors,dimensions,usage};
}
async function jsonResponse(response,limit=32*1024*1024){
  const reader=response.body?.getReader();if(!reader)fail('EMBEDDING_RESPONSE_INVALID','服务未返回 JSON 正文。');
  const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)fail('EMBEDDING_RESPONSE_INVALID','服务响应超过大小上限。');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('EMBEDDING_RESPONSE_INVALID','服务返回的内容不是有效 JSON。');}
}
export async function requestEmbeddings(profile,key,inputs,{signal,fetchImpl=fetch,onAttempt=()=>{},expectedDimension=profile.dimensions,maxRetries=2,sleep=delay}={}){
  key=validateEmbeddingKey(key);
  if(!inputs.length||inputs.length>profile.batchSize||inputs.some(input=>typeof input!=='string'||!input.length||input.length>profile.maxInputChars)||inputs.reduce((n,input)=>n+input.length,0)>MAX_BATCH_CHARS)fail('EMBEDDING_INPUT_TOO_LARGE','输入超过片段或批次上限；请调整分块或批量设置。');
  validateEmbeddingBatch(profile,inputs.length);
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();await onAttempt();
    const timeout=AbortSignal.timeout(profile.timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    let retryAfter=0;
    try{
      const response=await fetchImpl(profile.endpoint,{method:'POST',redirect:'error',signal:combined,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:profile.model,input:inputs,encoding_format:'float',...(profile.dimensions?{dimensions:profile.dimensions}:{})})});
      if(!response.ok){
        let payload;try{payload=await jsonResponse(response,32768);}catch{combined.throwIfAborted();}
        const failure=providerFailure(response,payload,{key,inputs,profile,attempts:attempt+1});
        if(failure.code==='EMBEDDING_QUOTA_EXCEEDED'||!retryableStatus.has(response.status)||attempt>=maxRetries)throw failure;
        retryAfter=Math.min(5000,Math.max(0,Number(response.headers.get('retry-after'))||0)*1000);
      }else return validateVectors(await jsonResponse(response),inputs.length,expectedDimension);
    }catch(error){
      signal?.throwIfAborted();
      if(typeof error?.code==='string'&&error.code.startsWith('EMBEDDING_'))throw error;
      if(attempt>=maxRetries){
        const timedOut=timeout.aborted||error?.name==='TimeoutError'||/TIMEOUT/.test(error?.cause?.code??'');
        throw embeddingError(timedOut?'EMBEDDING_TIMEOUT':'EMBEDDING_NETWORK_FAILED',timedOut?`单次请求等待 ${profile.timeoutMs/1000} 秒后超时，已尝试 ${attempt+1} 次。`:`无法连接服务，或连接中断/重定向被拒绝，已尝试 ${attempt+1} 次。`,{attempts:attempt+1,timeoutMs:profile.timeoutMs,inputCount:inputs.length});
      }
    }
    await sleep(Math.max(retryAfter,250*2**attempt),undefined,{signal});
  }
}
