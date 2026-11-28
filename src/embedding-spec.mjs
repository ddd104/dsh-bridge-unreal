// Shared public profile fields. API keys never belong to this object or Config.
export const EMBEDDING_INPUT_VERSION='title-section-text-v1';
export const EMBEDDING_NORMALIZATION='l2-f32-v1';
export function embeddingEndpoint(value) {
  let url;
  try {url=new URL(value);} catch {throw new Error('请输入完整的 Embedding 服务地址。');}
  if(url.username||url.password||url.search||url.hash)throw new Error('服务地址不能包含用户名、密码、查询参数或片段。');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('云端地址必须使用 HTTPS；本机服务可使用 HTTP。');
  const pathname=url.pathname.replace(/\/+$/,'');
  if(/\/(chat\/completions|responses|models)$/.test(pathname))throw new Error('请填写服务基础地址或完整的 /embeddings 地址。');
  url.pathname=pathname.endsWith('/embeddings')?pathname:pathname+'/embeddings';
  return url.href;
}

const text=(key,label,defaultValue,maxLength,hint,pattern)=>({key,label,type:'text',group:'embedding',defaultValue,maxLength,hint,pattern});
const number=(key,label,defaultValue,min,max,hint,scale=1,unit='')=>({key,label,type:'number',group:'embedding',defaultValue,min,max,hint,scale,unit});
export const EMBEDDING_FIELDS=Object.freeze([
  {key:'embeddingEnabled',label:'启用语义检索与云端向量',type:'boolean',group:'embedding',defaultValue:false,hint:'默认关闭。保存不调用服务；手动生成资料向量后，project_context 会发送当前查询生成查询向量，可能计费。'},
  text('embeddingProfileId','配置名称','default',64,'用于区分服务配置，不包含密钥。','^[a-z][a-z0-9-]{0,63}$'),
  {key:'embeddingProvider',label:'API 协议',type:'choice',group:'embedding',defaultValue:'openai-compatible',options:[{value:'openai-compatible',label:'OpenAI 兼容 Embeddings'}],hint:'POST /embeddings，输入文本数组，返回带 index 的数值向量。'},
  text('embeddingBaseUrl','服务地址','',2048,'例如 https://api.example.com/v1；自动追加 /embeddings，完整地址不会重复追加。'),
  text('embeddingModel','Embedding 模型','',200,'填写服务支持的 Embedding 模型名；不使用聊天模型自动代替。'),
  number('embeddingDimensions','输出维度',0,0,8192,'0 使用模型默认维度；大于 0 时服务必须支持 dimensions 参数。'),
  number('embeddingBatchSize','每批最多片段',10,1,128,'还受总输入预算约束；服务限额较低时减小此值。'),
  number('embeddingConcurrency','同时请求数',2,1,4,'仅影响显式启动的任务。'),
  number('embeddingMaxInputChars','单片段输入字符上限',16000,128,64000,'包含标题与正文；超过时停止并提示调整分块，避免静默截断。服务 Token 限制仍需按模型配置。'),
  number('embeddingTimeoutMs','单次请求超时',30000,1000,120000,'429 与临时错误最多重试两次；鉴权和模型错误不重试。',1000,'秒'),
  number('embeddingMaxRequests','任务请求次数上限',1000,1,10000,'包含重试；达到上限保留成功缓存，等待手动继续。'),
  number('embeddingJobTimeoutMs','向量任务总时限',1800000,1000,7200000,'超时后保留成功批次，不自动继续收费请求。',60000,'分钟'),
].map(Object.freeze));
export const EMBEDDING_DEFAULTS=Object.freeze(Object.fromEntries(EMBEDDING_FIELDS.map(f=>[f.key,f.defaultValue])));
