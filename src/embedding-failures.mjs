// Only locally generated explanations and bounded diagnostic fields cross the
// worker/UI boundary. Provider response bodies and document text never do.
export function embeddingFailure(error,{cancelled=false}={}){
  if(typeof error?.code==='string'&&/^(EMBEDDING_|PROJECT_|SOURCE_|KNOWLEDGE_|CANCELLED$|source_|document_|chunk_|cache_|path_|invalid_|unsupported_|file_|index_)/.test(error.code))
    return {code:error.code,message:error.message,...(error.details?{details:error.details}:{})};
  if(cancelled)return {code:'CANCELLED',message:'任务已取消；已成功生成的向量保留在项目缓存中。'};
  if(error?.code==='ENOSPC')return {code:'EMBEDDING_STORAGE_FULL',message:'写入向量缓存失败：磁盘空间不足。'};
  if(['EACCES','EPERM','EROFS'].includes(error?.code))return {code:'EMBEDDING_STORAGE_DENIED',message:'写入向量缓存失败：目录不可写或文件被占用。'};
  const exceptionType=['TypeError','RangeError','SyntaxError','TimeoutError','AbortError'].includes(error?.name)?error.name:'Error';
  return {code:'EMBEDDING_WORKER_FAILED',message:`向量处理发生内部异常（${exceptionType}），本次索引未发布。`,details:{exceptionType}};
}

export function embeddingFailureView(error,job){
  const code=error?.code??'UNKNOWN',details=error?.details??{};
  const legacy=job?.status==='failed'&&code==='CANCELLED'&&!job.failureStage;
  const hints={
    EMBEDDING_TIMEOUT:'在“高级参数”中增大“单次请求超时”，或减小每批片段数。保存后点击“生成/更新向量索引”，会复用成功缓存。',
    EMBEDDING_NETWORK_FAILED:'检查网络、代理和服务地址。网络恢复后可继续未完成任务。',
    EMBEDDING_BATCH_LIMIT:`将“每批最多片段”调为 ${details.limit??'服务允许的数量'} 或更小，保存后点击“生成/更新向量索引”。`,
    EMBEDDING_INPUT_TOO_LARGE:'缩小知识资料分块；提高插件字符上限不会提高服务商的 Token 上限。',
    EMBEDDING_QUOTA_EXCEEDED:'到服务商控制台检查余额、免费额度及付费服务是否启用。处理后可继续未完成任务。',
    EMBEDDING_RATE_LIMIT:'降低“同时请求数”，或稍后再试。成功缓存会复用。',
    EMBEDDING_AUTH_FAILED:'检查该服务地址对应的 API Key、业务空间及模型访问权限，并重新测试连接。',
    EMBEDDING_MODEL_UNSUPPORTED:'检查模型名称及所选业务空间是否已开通此模型。',
    EMBEDDING_DIMENSION_MISMATCH:'将“输出维度”设为 0（模型默认），或使用服务支持的维度；改变维度会建立新的向量空间。',
    EMBEDDING_ENDPOINT_INVALID:'检查服务地址，应为 OpenAI 兼容基础地址或完整的 /embeddings 地址。',
    EMBEDDING_BAD_REQUEST:'核对每批数量、文本长度、模型及维度；可先用单条连接测试排查。',
    EMBEDDING_HTTP_FAILED:'服务端暂时异常；稍后继续任务。如果反复发生，请携带下方 HTTP 状态和请求编号联系服务商。',
    EMBEDDING_RESPONSE_INVALID:'服务返回的数据不符合 Embeddings 协议；检查服务与模型，稍后重试。',
    EMBEDDING_STORAGE_FULL:'释放项目所在磁盘的空间后重试，保留现有成功向量缓存。',
    EMBEDDING_STORAGE_DENIED:'检查插件 Cache 目录写入权限和文件占用后重试。',
    EMBEDDING_JOB_TIMEOUT:'任务达到总时限。可继续未完成任务；也可调大“向量任务总时限”后重新生成。',
    EMBEDDING_REQUEST_LIMIT:'任务达到请求次数上限。可继续未完成任务，或调整上限后重新生成。',
    EMBEDDING_CONFIG_CHANGED:'设置已变化。请点击“生成/更新向量索引”启动新任务。',
    EMBEDDING_CREDENTIAL_CHANGED:'凭据已变化。保存对应 API Key 并测试连接后，再生成或继续任务。',
    SOURCE_CHANGED:'资料在构建期间变化。停止编辑资料后重新生成，未变化的输入可复用缓存。',
    HOST_EXITED:'上次宿主退出前任务未完成。可继续任务，成功缓存会复用。',
    CANCELLED:'需要继续时点击“继续未完成任务”，成功缓存会复用。',
    EMBEDDING_WORKER_FAILED:'请保留任务编号反馈此错误。修复后可继续任务，不必删除成功缓存。',
  };
  const diagnostics=[
    code!=='UNKNOWN'?`错误码：${code}`:null,
    details.httpStatus?`HTTP ${details.httpStatus}`:null,
    details.providerCode?`服务码：${details.providerCode}`:null,
    details.requestId?`服务请求：${details.requestId}`:null,
    details.attempts?`本批尝试 ${details.attempts} 次`:null,
    job?.jobId?`任务编号：${job.jobId}`:null,
  ].filter(Boolean);
  return {summary:legacy?'旧版任务丢失了原始失败原因，不能据此判断为手动取消。':error?.message??'操作失败，未收到详细原因。',
    hint:legacy?'成功缓存仍可复用。更新插件后继续任务；如果再次失败，将显示具体原因。':hints[code]??'请根据错误原因处理后重试；如果反复失败，请保留错误码和任务编号。',diagnostics};
}
