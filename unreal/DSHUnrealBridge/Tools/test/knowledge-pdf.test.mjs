import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {parsePdf} from '../ProjectMemorySystem/dist/src/sources/pdfParser.js';
import {loadProjectConfig} from '../ProjectMemorySystem/dist/src/config/loadProjectConfig.js';
import {indexDocuments,collectDocuments} from '../ProjectMemorySystem/dist/src/index/documentIndexer.js';
import {readIndexedDocument} from '../ProjectMemorySystem/dist/src/commands/readDocument.js';
import {hybridSearch} from '../ProjectMemorySystem/dist/src/retrieval/hybridSearch.js';
import {chunkDocument} from '../ProjectMemorySystem/dist/src/index/documentChunks.js';

const sample=name=>readFile(new URL(`./fixtures/pdf/${name}`,import.meta.url));
async function fixture(t,names=['pages.pdf']){
  const base=fileURLToPath(new URL('../../Cache/TestRuns/Temp/',import.meta.url));await mkdir(base,{recursive:true});
  const root=await mkdtemp(path.join(base,'PDF 中文 '));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'Docs'));await writeFile(path.join(root,'Fixture.uproject'),'{}');
  await writeFile(path.join(root,'ProjectMemory.project.json'),JSON.stringify({schemaVersion:1,projectId:'pdf',knowledgeRoots:['Docs'],memoryOutputRoot:'.ai/memory',graph:{enabled:false,mode:'sqlite'},memory:{chunking:{targetChars:180,overlapChars:20,maxChars:300}}}));
  for(const name of names)await writeFile(path.join(root,'Docs',name),await sample(name));
  return {root,loaded:await loadProjectConfig({projectRoot:root})};
}

test('PDF text preserves Chinese, physical pages, printed labels, rotation and page-local chunk offsets',async t=>{
  const parsed=await parsePdf('pages.pdf',await sample('pages.pdf'));
  assert.equal(parsed.metadata.pdf.pageCount,5);assert.deepEqual(parsed.metadata.pdf.noTextPages,[2,3]);
  assert.deepEqual(parsed.blocks.map(b=>b.location.page),[1,4,5]);assert.equal(parsed.blocks[0].location.pageLabel,'i');assert.equal(parsed.blocks[1].location.pageLabel,'2');
  assert.match(parsed.blocks[0].text,/车辆休眠唤醒流程/);assert.match(parsed.blocks[2].text,/RotatedPageMarker/);
  const f=await fixture(t),result=await indexDocuments(f.loaded);assert.ok(result.warnings.some(w=>w.includes('pdf_needs_ocr_or_blank')));
  const [document]=(await collectDocuments(f.loaded)).documents;
  const pages=new Map(parsed.blocks.map(b=>[b.location.page,b.text]));
  assert.ok(document.chunks.length>10);
  for(const chunk of document.chunks){assert.equal(chunk.location.kind,'pdf');assert.ok(chunk.text.length<=300);assert.equal(chunk.text,pages.get(chunk.location.page).slice(chunk.location.textStart,chunk.location.textEnd));}
  for(const [query,page] of [['休眠唤醒流程',1],['LaterPageMarker',4],['RotatedPageMarker',5]]){
    const hit=(await hybridSearch(query,f.loaded)).results[0];assert.ok(hit,query);assert.equal(hit.location.page,page);
    const read=await readIndexedDocument(f.loaded,'read_chunk',{chunkId:hit.chunkId,expectedHash:hit.sourceHash});assert.equal(read.location.page,page);assert.ok(read.content.includes(hit.excerpt));
  }
  let offset=0,seen=[];
  do{const result=await readIndexedDocument(f.loaded,'read_document',{documentId:document.id,offset,maxChunks:2});seen.push(...result.chunks);offset=result.nextOffset;}while(offset!==null);
  assert.deepEqual(seen.map(c=>c.chunkId),document.chunks.map(c=>c.chunkId));
  const unicode=chunkDocument('unicode',[{text:'唤醒😀'.repeat(100),kind:'paragraph',headingPath:[],location:{kind:'pdf',page:7,textStart:0,textEnd:400}}],{targetChars:33,overlapChars:10,maxChars:66});
  assert.ok(unicode.every(c=>c.text.isWellFormed()&&c.text==='唤醒😀'.repeat(100).slice(c.location.textStart,c.location.textEnd)));
  const raw=('a'.repeat(35)+'\n').repeat(3)+'tail',slices=chunkDocument('slices',[{text:raw,kind:'paragraph',headingPath:[],location:{kind:'pdf',page:1,textStart:0,textEnd:raw.length}}],{targetChars:64,overlapChars:0,maxChars:96});
  for(const chunk of slices)assert.equal(chunk.text,raw.slice(chunk.location.textStart,chunk.location.textEnd));
});

test('PDF scan-only and blank pages retain diagnostics without fabricated searchable text; malformed and locked files are skipped',async t=>{
  const f=await fixture(t,['scan.pdf','password.pdf','damaged.pdf']);const result=await indexDocuments(f.loaded);
  assert.equal(result.documentsIndexed,1);assert.equal(result.chunksIndexed,0);
  for(const code of ['pdf_needs_ocr_or_blank','pdf_password_required','pdf_parse_failed'])assert.ok(result.warnings.some(w=>w.includes(code)),code);
  const search=await hybridSearch('ScannedOnlyMarker',f.loaded);assert.deepEqual(search.results,[]);assert.ok(search.warnings.some(w=>w.includes('需要 OCR')));
  const next=await indexDocuments(f.loaded,{incremental:true,previousSources:result.sources});assert.ok(next.warnings.some(w=>w.includes('pdf_needs_ocr_or_blank')));
  const [doc]=(await collectDocuments(f.loaded)).documents;
  const read=await readIndexedDocument(f.loaded,'read_document',{documentId:doc.id});assert.equal(read.totalChunks,0);assert.equal(read.metadata.pdf.ocrStatus,'not_performed');
});

test('PDF references reject changed, deleted and foreign sources; updating removes old chunks and policy can exclude PDFs',async t=>{
  const f=await fixture(t),other=await fixture(t);await indexDocuments(f.loaded);await indexDocuments(other.loaded);
  const hit=(await hybridSearch('FirstPageMarker',f.loaded)).results[0];
  await assert.rejects(readIndexedDocument(other.loaded,'read_chunk',{chunkId:hit.chunkId}),{code:'chunk_not_found'});
  const file=path.join(f.root,'Docs/pages.pdf');await writeFile(file,await sample('scan.pdf'));
  await assert.rejects(readIndexedDocument(f.loaded,'read_chunk',{chunkId:hit.chunkId}),{code:'source_changed'});
  assert.deepEqual((await hybridSearch('FirstPageMarker',f.loaded)).results,[]);
  await indexDocuments(f.loaded);await assert.rejects(readIndexedDocument(f.loaded,'read_chunk',{chunkId:hit.chunkId}),{code:'chunk_not_found'});
  await rm(file);assert.equal((await indexDocuments(f.loaded)).documentsIndexed,0);
  other.loaded.config.sourcePolicy={includeExtensions:['.md']};assert.equal((await indexDocuments(other.loaded)).documentsIndexed,0);
});

test('PDF page and extraction limits reject oversized content rather than publish truncated evidence',async()=>{
  // A tiny valid PDF declares 501 real page objects; avoids a huge binary fixture.
  const count=501,objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:count},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${count} >>`,...Array.from({length:count},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>')];
  let data='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await assert.rejects(parsePdf('many.pdf',Buffer.from(data)),{code:'pdf_limit_exceeded'});
});
