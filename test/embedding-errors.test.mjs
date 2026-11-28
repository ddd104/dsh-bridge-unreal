import test from 'node:test';
import assert from 'node:assert/strict';
import {embeddingProfile} from '../src/embedding-profile.mjs';
import {requestEmbeddings} from '../src/embedding-provider.mjs';
import {embeddingFailure,embeddingFailureView} from '../src/embedding-failures.mjs';

const key='private-api-key-do-not-display',input='Confidential project document body';
const profile=embeddingProfile({embeddingEnabled:true,embeddingBaseUrl:'https://example.test/v1',embeddingModel:'test'});

test('numeric DOM timeout codes are retryable timeouts, never a TypeError or cancellation',async()=>{
  let calls=0;
  await assert.rejects(requestEmbeddings(profile,key,[input],{sleep:async()=>{},fetchImpl:async()=>{calls++;throw new DOMException('unsafe '+key,'TimeoutError');}}),error=>{
    assert.equal(error.code,'EMBEDDING_TIMEOUT');assert.equal(error.details.attempts,3);assert.equal(error.details.timeoutMs,30000);assert.ok(!JSON.stringify(error).includes(key));return true;
  });assert.equal(calls,3);
});

test('HTTP errors explain quota, rate, batch, input, dimensions and endpoint problems without echoing secrets or documents',async()=>{
  for(const [status,code,message,expected] of [
    [403,'AllocationQuota.FreeTierOnly','Free tier exhausted','EMBEDDING_QUOTA_EXCEEDED'],
    [429,'insufficient_quota','insufficient quota','EMBEDDING_QUOTA_EXCEEDED'],
    [429,'Throttling.RateQuota','Rate quota exceeded','EMBEDDING_RATE_LIMIT'],
    [400,'InvalidParameter','batch size must not exceed 10','EMBEDDING_BATCH_LIMIT'],
    [400,'InvalidParameter','input length exceeds maximum','EMBEDDING_INPUT_TOO_LARGE'],
    [400,'InvalidParameter','dimensions unsupported','EMBEDDING_DIMENSION_MISMATCH'],
    [404,'ModelNotFound','model does not exist','EMBEDDING_MODEL_UNSUPPORTED'],
    [404,'NotFound','route missing','EMBEDDING_ENDPOINT_INVALID'],
    [422,'Unknown','unrecognized parameter','EMBEDDING_BAD_REQUEST'],
    [401,'invalid_api_key','invalid API key','EMBEDDING_AUTH_FAILED'],
    [503,'Unavailable','server unavailable','EMBEDDING_HTTP_FAILED'],
  ]){
    let attempts=0;const requestId='12345678-1234-1234-1234-123456789abc';
    await assert.rejects(requestEmbeddings(profile,key,[input],{sleep:async()=>{},fetchImpl:async()=>{attempts++;return new Response(JSON.stringify({error:{code,message:`${message}; ${key}; ${input}`},request_id:requestId}),{status});}}),error=>{
      assert.equal(error.code,expected);assert.equal(error.details.httpStatus,status);assert.equal(error.details.requestId,requestId);assert.equal(error.details.providerCode,code);
      const serialized=JSON.stringify({message:error.message,...error});assert.ok(!serialized.includes(key));assert.ok(!serialized.includes(input));assert.match(error.message,new RegExp(`HTTP ${status}`));return true;
    });assert.equal(attempts,expected==='EMBEDDING_RATE_LIMIT'||status===503?3:1);
  }
});

test('Aliyun v4 batch limit fails locally before sending a document; connection test still supports one input',async()=>{
  const ali=embeddingProfile({embeddingEnabled:true,embeddingBaseUrl:'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',embeddingModel:'text-embedding-v4',embeddingBatchSize:16});let calls=0;
  const fetchImpl=async()=>{calls++;return new Response(JSON.stringify({data:[{index:0,embedding:[1,0]}]}));};
  await assert.rejects(requestEmbeddings(ali,key,Array(16).fill(input),{fetchImpl}),error=>error.code==='EMBEDDING_BATCH_LIMIT'&&error.details.limit===10&&/16.*10/.test(error.message));assert.equal(calls,0);
  await requestEmbeddings(ali,key,[input],{fetchImpl});assert.equal(calls,1);
});

test('malformed or oversized provider errors are bounded and never displayed as raw text',async()=>{
  for(const body of ['not-json '+key,'x'.repeat(40000)+input])await assert.rejects(requestEmbeddings(profile,key,[input],{fetchImpl:async()=>new Response(body,{status:400})}),error=>error.code==='EMBEDDING_BAD_REQUEST'&&!error.message.includes(key)&&!JSON.stringify(error).includes(input));
  await assert.rejects(requestEmbeddings(profile,key,[input],{fetchImpl:async()=>new Response(JSON.stringify({error:{code:key,message:input},request_id:key}),{status:400})}),error=>!JSON.stringify(error).includes(key)&&!JSON.stringify(error).includes(input));
});

test('internal worker failures stay failures; historical cancelled records are explicitly uncertain',()=>{
  const failure=embeddingFailure(new TypeError(key));assert.equal(failure.code,'EMBEDDING_WORKER_FAILED');assert.equal(failure.details.exceptionType,'TypeError');assert.ok(!failure.message.includes(key));
  assert.equal(embeddingFailure(new DOMException('cancelled','AbortError'),{cancelled:true}).code,'CANCELLED');
  const view=embeddingFailureView({code:'CANCELLED',message:'向量任务已停止。'},{status:'failed'});assert.match(view.summary,/丢失.*原因/);assert.match(view.summary,/不能.*手动取消/);
});
