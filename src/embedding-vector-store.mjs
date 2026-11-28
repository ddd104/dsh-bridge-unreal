// Imported only by the vector worker; no optional vector DLL is needed by base queries.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {renameSync} from 'node:fs';
import {embeddingError} from './embedding-profile.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function encode(vector){const bytes=Buffer.alloc(vector.length*4);for(let i=0;i<vector.length;i++)bytes.writeFloatLE(vector[i],i*4);return bytes;}
function decode(row,dimensions){
  if(!row||row.dimensions!==dimensions||row.vector.byteLength!==dimensions*4||digest(row.vector)!==row.hash)return null;
  const bytes=Buffer.from(row.vector),vector=new Float32Array(dimensions);let norm=0;
  for(let i=0;i<dimensions;i++){const value=bytes.readFloatLE(i*4);if(!Number.isFinite(value))return null;vector[i]=value;norm+=value*value;}
  return Math.abs(norm-1)<0.001?vector:null;
}
export class EmbeddingVectorCache {
  constructor(file){
    const initialize=()=>{this.db=new DatabaseSync(file);this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS spaces (fingerprint TEXT PRIMARY KEY, dimensions INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS vectors (fingerprint TEXT NOT NULL, inputHash TEXT NOT NULL, dimensions INTEGER NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(fingerprint,inputHash));');};
    try{initialize();}catch(error){
      try{this.db?.close();}catch{}
      // Only a user-started build opens the cache for writes, under the project
      // lock. Preserve the damaged file; never hide permissions or disk errors.
      if(![11,26].includes(error.errcode&255))throw error;
      renameSync(file,`${file}.corrupt-${randomUUID()}`);this.recovered=true;initialize();
    }
  }
  dimensions(fingerprint){return this.db.prepare('SELECT dimensions FROM spaces WHERE fingerprint=?').get(fingerprint)?.dimensions??0;}
  get(fingerprint,inputHash){
    const dimensions=this.dimensions(fingerprint);if(!dimensions)return null;
    const row=this.db.prepare('SELECT dimensions,hash,vector FROM vectors WHERE fingerprint=? AND inputHash=?').get(fingerprint,inputHash);
    const vector=decode(row,dimensions);if(row&&!vector)this.db.prepare('DELETE FROM vectors WHERE fingerprint=? AND inputHash=?').run(fingerprint,inputHash);return vector;
  }
  put(fingerprint,inputs,vectors,dimensions){
    const previous=this.dimensions(fingerprint);
    if(previous&&previous!==dimensions)throw embeddingError('EMBEDDING_DIMENSION_MISMATCH','同一向量空间的返回维度发生变化，请指定模型版本或显式维度建立新空间。');
    this.db.exec('BEGIN');
    try{
      this.db.prepare('INSERT OR IGNORE INTO spaces VALUES (?,?)').run(fingerprint,dimensions);
      const insert=this.db.prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?)');
      inputs.forEach((input,index)=>{const vector=encode(vectors[index]);insert.run(fingerprint,input.inputHash,dimensions,digest(vector),vector);});
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
}
export function writeVectorIndex(file,manifest,entries,cache){
  const db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE manifest (record TEXT NOT NULL); CREATE TABLE vectors (inputHash TEXT PRIMARY KEY,dimensions INTEGER NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL); CREATE TABLE chunks (chunkId TEXT PRIMARY KEY,documentId TEXT NOT NULL,path TEXT NOT NULL,sourceHash TEXT NOT NULL,inputHash TEXT NOT NULL); CREATE INDEX chunks_by_input ON chunks(inputHash); BEGIN;');
    db.prepare('INSERT INTO manifest VALUES (?)').run(JSON.stringify(manifest));
    const vectorInsert=db.prepare('INSERT INTO vectors VALUES (?,?,?,?)'),chunkInsert=db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?)'),seen=new Set();
    for(const entry of entries){
      if(!seen.has(entry.inputHash)){
        const values=cache.get(manifest.spaceFingerprint,entry.inputHash);if(!values)throw embeddingError('EMBEDDING_CACHE_INVALID','缓存片段向量缺失，请手动继续任务。');
        const vector=encode(values);vectorInsert.run(entry.inputHash,values.length,digest(vector),vector);seen.add(entry.inputHash);
      }
      chunkInsert.run(entry.chunkId,entry.documentId,entry.path,entry.sourceHash,entry.inputHash);
    }
    db.exec('PRAGMA user_version=1; COMMIT;');
  }finally{db.close();}
}
export function searchVectorIndex(file,queryVector,{spaceFingerprint,limit=20}={}){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const manifest=JSON.parse(db.prepare('SELECT record FROM manifest').get().record);
    if(manifest.spaceFingerprint!==spaceFingerprint||manifest.dimensions!==queryVector.length||!Array.from(queryVector).every(Number.isFinite))throw embeddingError('EMBEDDING_INDEX_INCOMPATIBLE','向量索引与当前模型空间不兼容。');
    limit=Math.min(40,Math.max(1,Math.floor(limit)));const top=[];
    for(const row of db.prepare('SELECT * FROM vectors').iterate()){
      const vector=decode(row,manifest.dimensions);if(!vector)throw embeddingError('EMBEDDING_INDEX_INVALID','向量索引损坏，请显式重建。');
      let score=0;for(let i=0;i<vector.length;i++)score+=vector[i]*queryVector[i];
      top.push({inputHash:row.inputHash,score});top.sort((a,b)=>b.score-a.score||a.inputHash.localeCompare(b.inputHash));if(top.length>limit)top.pop();
    }
    const results=[];
    for(const item of top)for(const chunk of db.prepare('SELECT * FROM chunks WHERE inputHash=? ORDER BY chunkId LIMIT ?').all(item.inputHash,limit))results.push({...chunk,score:item.score});
    return {manifest,results:results.slice(0,limit)};
  }finally{db.close();}
}
export function inspectVectorIndex(file,spaceFingerprint){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const manifest=JSON.parse(db.prepare('SELECT record FROM manifest').get().record);
    if(manifest.schemaVersion!==1||manifest.spaceFingerprint!==spaceFingerprint||!Number.isInteger(manifest.dimensions)||manifest.dimensions<1||manifest.dimensions>8192)throw embeddingError('EMBEDDING_INDEX_INCOMPATIBLE','向量索引与当前配置不兼容。');
    if(db.prepare('SELECT count(*) AS count FROM chunks').get().count!==manifest.chunksIndexed)throw embeddingError('EMBEDDING_INDEX_INVALID','向量引用映射不完整。');
    return {manifest};
  }finally{db.close();}
}
