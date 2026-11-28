import {createHash} from 'node:crypto';
import {EMBEDDING_FIELDS,EMBEDDING_DEFAULTS,EMBEDDING_INPUT_VERSION,EMBEDDING_NORMALIZATION,embeddingEndpoint} from './embedding-spec.mjs';
import {fieldValueError} from './settings-spec.mjs';

export const hashEmbedding=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function embeddingError(code,message,details){return Object.assign(new Error(message),{code,...(details?{details}:{})});}
export function embeddingProfile(config,{required=false}={}) {
  const values=Object.fromEntries(EMBEDDING_FIELDS.map(field=>[field.key,config[field.key]??EMBEDDING_DEFAULTS[field.key]]));
  for(const field of EMBEDDING_FIELDS){const error=fieldValueError(field,values[field.key]);if(error)throw embeddingError('EMBEDDING_CONFIG_INVALID',`${field.label}: ${error}`);}
  const endpoint=values.embeddingBaseUrl.trim()?embeddingEndpoint(values.embeddingBaseUrl.trim()):'';
  const profile={enabled:values.embeddingEnabled,profileId:values.embeddingProfileId,provider:values.embeddingProvider,endpoint,model:values.embeddingModel.trim(),dimensions:values.embeddingDimensions,
    batchSize:values.embeddingBatchSize,concurrency:values.embeddingConcurrency,maxInputChars:values.embeddingMaxInputChars,timeoutMs:values.embeddingTimeoutMs,maxRequests:values.embeddingMaxRequests,jobTimeoutMs:values.embeddingJobTimeoutMs,
    inputVersion:EMBEDDING_INPUT_VERSION,normalization:EMBEDDING_NORMALIZATION};
  profile.spaceFingerprint=hashEmbedding([profile.provider,endpoint,profile.model,profile.dimensions,profile.inputVersion,profile.normalization]);
  profile.configFingerprint=hashEmbedding(profile);
  if(required){
    if(!profile.enabled)throw embeddingError('EMBEDDING_DISABLED','请先保存并启用云端向量功能。');
    if(!endpoint||!profile.model)throw embeddingError('EMBEDDING_CONFIG_INCOMPLETE','请先保存服务地址和 Embedding 模型。');
  }
  return Object.freeze(profile);
}
export function requireProfileRevision(profile,expected){if(expected!==profile.configFingerprint)throw embeddingError('EMBEDDING_CONFIG_CHANGED','配置已变化，请刷新已保存设置后重试。');}
