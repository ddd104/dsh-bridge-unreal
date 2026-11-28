import {z} from 'zod';
import {knowledgeSchema} from './protocol.mjs';

export const projectHandleSchema=z.string().regex(/^project-[a-f0-9]{64}$/);
export const hostDocumentToolNames=Object.freeze(['read_document','read_chunk']);
export const hostKnowledgeSchema=knowledgeSchema.extend({tool:z.enum([...knowledgeSchema.shape.tool.options,...hostDocumentToolNames,'snapshot_import']),projectHandle:projectHandleSchema.optional(),backend:z.enum(['auto','local','editor']).optional()});
export const knowledgeBuildSchema=z.object({projectHandle:projectHandleSchema,requestId:z.string().uuid()}).strict();
export const knowledgeStatusSchema=z.object({projectHandle:projectHandleSchema,jobId:z.string().uuid().optional()}).strict();
export const knowledgeCancelSchema=z.object({projectHandle:projectHandleSchema,jobId:z.string().uuid()}).strict();
