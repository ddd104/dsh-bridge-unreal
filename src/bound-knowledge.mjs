import {z} from 'zod';
import {knowledgeBuildSchema,knowledgeCancelSchema} from './knowledge-protocol.mjs';
import {embeddingBuildSchema,embeddingCancelSchema,embeddingResumeSchema} from './embedding-protocol.mjs';

export const boundKnowledgeActionSchema=z.discriminatedUnion('action',[
  ['baseBuild',knowledgeBuildSchema],['baseCancel',knowledgeCancelSchema],
  ['build',embeddingBuildSchema],['cancel',embeddingCancelSchema],['resume',embeddingResumeSchema],
].map(([action,schema])=>schema.extend({action:z.literal(action),bindingVersion:z.number().int().nonnegative()})));
