import {embeddingError} from './embedding-profile.mjs';

export function knownEmbeddingBatchLimit(profile){
  const host=new URL(profile.endpoint).hostname;
  return /(^|\.)maas\.aliyuncs\.com$/.test(host)||/^dashscope(?:-intl|-us)?\.aliyuncs\.com$/.test(host)
    ?['text-embedding-v3','text-embedding-v4'].includes(profile.model)?10:null:null;
}
export function validateEmbeddingBatch(profile,count){
  const limit=knownEmbeddingBatchLimit(profile);
  if(limit&&count>limit)throw embeddingError('EMBEDDING_BATCH_LIMIT',`当前每批 ${count} 条文本，服务上限为 ${limit} 条；请减小“每批最多片段”。`,{inputCount:count,limit});
}

export function providerFailure(response,payload,{key,inputs,profile,attempts}){
  const status=response.status,upstream=payload?.error??payload??{};
  const code=typeof upstream.code==='string'?upstream.code:'',type=typeof upstream.type==='string'?upstream.type:'';
  const message=typeof upstream.message==='string'?upstream.message:'';
  // Read the body only to recognize a category; never echo arbitrary upstream
  // messages, which can contain credentials or submitted document text.
  const text=`${code} ${type} ${message}`.toLowerCase();
  const safeToken=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,96}$/.test(value)&&!value.includes(key)&&!/^sk[-_]/i.test(value)&&!inputs.some(input=>value.includes(input));
  const requestId=response.headers.get('x-request-id')??payload?.request_id??payload?.requestId;
  const details={httpStatus:status,inputCount:inputs.length,attempts,
    ...(safeToken(code)?{providerCode:code}:{}),
    ...(safeToken(requestId)&&/^[a-f0-9-]{12,80}$/i.test(requestId)?{requestId}:{}),
  };
  const failure=(errorCode,summary,extra)=>embeddingError(errorCode,`${summary}（HTTP ${status}）。`,{...details,...extra});
  const rateLimited=/throttl|rate.?limit|ratequota|请求频率/.test(text);
  if(/insufficient[_ .-]?(quota|balance)|arrearage|free.?tier.*(exhaust|only)|allocationquota|payment.?required|balance.*(insufficient|exhaust)|余额不足|额度.*(耗尽|不足|用完)|欠费/.test(text)||!rateLimited&&/quota.*(exceed|exhaust)/.test(text)||status===402)
    return failure('EMBEDDING_QUOTA_EXCEEDED','服务额度不足、余额不足或付费调用未开通');
  if(status===401||status===403)return failure('EMBEDDING_AUTH_FAILED',status===401?'API Key 无效、过期或与服务地址不匹配':'当前 API Key 没有访问此模型或业务空间的权限');
  if(status===429)return failure('EMBEDDING_RATE_LIMIT','服务请求频率或 Token 速率达到限制，有限重试后仍失败');
  if(/batch.*(size|limit|max)|input.*(array|list).*(size|length|limit)|too many (inputs|texts)|批次|每批|文本.*数量/.test(text)){
    const limit=knownEmbeddingBatchLimit(profile);
    return failure('EMBEDDING_BATCH_LIMIT',`服务拒绝了本批 ${inputs.length} 条文本：超过每批数量限制`,limit?{limit}:{});
  }
  if(/dimension|维度/.test(text))return failure('EMBEDDING_DIMENSION_MISMATCH','服务不支持当前输出维度，请使用 0 或模型支持的维度');
  if(/max.?token|token.*(limit|exceed|long)|input.*(length|long)|sequence.*length|文本.*(长度|过长)|长度.*(超|限制)/.test(text))return failure('EMBEDDING_INPUT_TOO_LARGE','本批中有文本超过模型的输入长度限制');
  if(/model.*(not.?found|not.?exist|unsupported|invalid)|invalid.*model|模型.*(不存在|不支持)/.test(text))return failure('EMBEDDING_MODEL_UNSUPPORTED','服务未找到或不支持当前 Embedding 模型');
  if(status===404)return failure('EMBEDDING_ENDPOINT_INVALID','服务接口或模型不存在，请核对地址、模型及业务空间');
  if(status===400||status===422)return failure('EMBEDDING_BAD_REQUEST','服务拒绝请求参数；无法从返回内容确定具体字段');
  return failure('EMBEDDING_HTTP_FAILED',status>=500?'服务端暂时异常，有限重试后仍失败':'服务拒绝了 Embedding 请求');
}
