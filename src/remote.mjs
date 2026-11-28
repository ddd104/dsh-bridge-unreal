import {z} from 'zod';
import {PACKAGE,id,assetCandidatesEditSchema} from './protocol.mjs';
import {knowledgeBuildSchema,knowledgeStatusSchema,knowledgeCancelSchema} from './knowledge-protocol.mjs';
import {embeddingStatusSchema,embeddingTestSchema,embeddingCredentialSchema,embeddingRemoveCredentialSchema,embeddingBuildSchema,embeddingCancelSchema,embeddingResumeSchema} from './embedding-protocol.mjs';
import {boundKnowledgeActionSchema} from './bound-knowledge.mjs';
const codec=(label,schema)=>({mode:'strict',typeSymbol:`${PACKAGE}#${label}`,create:()=>schema});
const agent={name:'agent',wire:'agentId',source:'lookup',lookup:'agent',codec:{mode:'strict',typeSymbol:'@deepseek-ai/dsh-session/types#SessionId',create:()=>id}};
const descriptor=(method,parameters=[])=>({id:`${PACKAGE}#unrealBridge/${method}`,service:'unrealBridge',namespace:'unrealBridge',method,invocation:{kind:'direct'},scope:{context:'agent',wire:'agentId'},parameters:[agent,...parameters],result:codec('BridgeState',z.json())});
// Global plugin settings pages have no owning conversation. Direct descriptors
// without a scope/lookup parameter are the official Typert global form.
const globalDescriptor=(method,parameters=[])=>({id:`${PACKAGE}#unrealBridge/${method}`,service:'unrealBridge',namespace:'unrealBridge',method,invocation:{kind:'direct'},parameters,result:codec('CacheState',z.json())});
const descriptors=[descriptor('state'),descriptor('bind',[{name:'editorId',wire:'editorId',source:'json',codec:codec('EditorId',id.nullable())}]),
  descriptor('editAssetCandidates',[{name:'options',wire:'options',source:'json',codec:codec('AssetCandidatesEdit',assetCandidatesEditSchema)}]),
  descriptor('knowledgeWorkspaceProjects'),
  descriptor('knowledgeContext'),
  descriptor('knowledgeAction',[{name:'options',wire:'options',source:'json',codec:codec('BoundKnowledgeAction',boundKnowledgeActionSchema)}]),
  globalDescriptor('knowledgeProjects'),
  ...[['embeddingStatus',embeddingStatusSchema],['embeddingTest',embeddingTestSchema],['embeddingSetCredential',embeddingCredentialSchema],['embeddingRemoveCredential',embeddingRemoveCredentialSchema],['embeddingBuild',embeddingBuildSchema],['embeddingCancel',embeddingCancelSchema],['embeddingResume',embeddingResumeSchema]].map(([method,schema])=>globalDescriptor(method,[{name:'options',wire:'options',source:'json',codec:codec(method,schema)}])),
  ...[['knowledgeStatus',knowledgeStatusSchema],['knowledgeBuild',knowledgeBuildSchema],['knowledgeCancel',knowledgeCancelSchema]].map(([method,schema])=>globalDescriptor(method,[{name:'options',wire:'options',source:'json',codec:codec(method,schema)}])),
  globalDescriptor('cacheStatus'),
  globalDescriptor('cacheCleanup',[{name:'options',wire:'options',source:'json',codec:codec('CacheCleanup',z.object({mode:z.enum(['policy','all_idle'])}).strict())}])];
export const TYPERT={package:PACKAGE,face:'host',schemas:[],invocations:descriptors,model:{services:[],events:[],objects:[]}};
export const TYPERT_REMOTE={package:PACKAGE,descriptors};
export default TYPERT_REMOTE;
