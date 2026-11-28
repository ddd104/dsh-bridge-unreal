import {hashEmbedding} from './embedding-profile.mjs';
export function projectKnowledgePolicy(policy){return {...structuredClone(policy),knowledgeRoots:['ProjectKnowledge']};}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function indexPolicyFingerprint(policy){
  const value=structuredClone(policy);
  // This switch controls queries, not which bytes belong to the stored index.
  if(value.memory){delete value.memory.semanticRetrieval;if(!Object.keys(value.memory).length)delete value.memory;}
  return hashEmbedding(canonical(value));
}
