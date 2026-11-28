import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rename,rm,symlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {loadProjectConfig} from '../ProjectMemorySystem/dist/src/config/loadProjectConfig.js';
import {collectDocuments,indexDocuments} from '../ProjectMemorySystem/dist/src/index/documentIndexer.js';
import {chunkDocument,chunkPolicy,documentIdentity} from '../ProjectMemorySystem/dist/src/index/documentChunks.js';
import {textBlocks} from '../ProjectMemorySystem/dist/src/sources/textStructure.js';
import {parseWiki} from '../ProjectMemorySystem/dist/src/sources/wikiParser.js';
import {createDefaultSourceRegistry} from '../ProjectMemorySystem/dist/src/sources/sourceRegistry.js';
import {readIndexedDocument} from '../ProjectMemorySystem/dist/src/commands/readDocument.js';
import {hybridSearch} from '../ProjectMemorySystem/dist/src/retrieval/hybridSearch.js';
import {MemoryStore} from '../ProjectMemorySystem/dist/src/memory/memoryStore.js';

const tempRoot=fileURLToPath(new URL('../../Cache/TestRuns/Temp/',import.meta.url));
async function fixture(t,files={},chunking={targetChars:120,overlapChars:20,maxChars:240}) {
  await mkdir(tempRoot,{recursive:true});
  const root=await realpath(await mkdtemp(path.join(tempRoot,'M2 中文 ')));
  t.after(async()=>{assert.ok(path.relative(tempRoot,root)&&!path.relative(tempRoot,root).startsWith('..'));await rm(root,{recursive:true,force:true});});
  const put=async(file,content)=>{const absolute=path.join(root,file);await mkdir(path.dirname(absolute),{recursive:true});await writeFile(absolute,content);};
  const config={schemaVersion:1,projectId:'m2',knowledgeRoots:['Docs','ProjectKnowledge'],memoryOutputRoot:'.ai/memory',graph:{enabled:false,mode:'sqlite'},memory:{chunking}};
  await put('Fixture.uproject','{}');await put('ProjectMemory.project.json',JSON.stringify(config));
  for(const [file,text] of Object.entries(files))await put(file,text);
  const loaded=await loadProjectConfig({projectRoot:root});
  return {root,loaded,put,config,store:new MemoryStore(loaded.resolvedMemoryOutputRoot)};
}
const docs=async f=>(await collectDocuments(f.loaded)).documents;
const read=(f,tool,args)=>readIndexedDocument(f.loaded,tool,args);

test('M2 XLSX preserves worksheet names, sparse ranges and headers; XLS remains readable',async t=>{
  const sheet='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="B3:D9"/><sheetData><row r="3"><c r="B3" t="inlineStr"><is><t>Name</t></is></c><c r="D3" t="inlineStr"><is><t>Value</t></is></c></row><row r="7"><c r="B7" t="inlineStr"><is><t>WakeMarker</t></is></c><c r="D7"><v>42</v></c></row><row r="9"><c r="B9" t="inlineStr"><is><t>LaterMarker</t></is></c><c r="D9"><v>43</v></c></row></sheetData></worksheet>';
  const xlsx=zip({
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="信号" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':sheet
  });
  const f=await fixture(t,{'Docs/signals.xlsx':xlsx},{targetChars:32,overlapChars:0,maxChars:64}),[doc]=await docs(f);assert.ok(doc);assert.deepEqual(doc.metadata.sheetNames,['信号']);
  const last=doc.chunks.at(-1);assert.equal(last.location.sheet,'信号');assert.equal(last.location.startRow,9);assert.equal(last.location.range,'B9:D9');assert.equal(last.location.headerRange,'B3:D3');assert.equal(last.text,'Name\t\tValue\nLaterMarker\t\t43');
  await indexDocuments(f.loaded);assert.equal((await read(f,'read_chunk',{chunkId:last.chunkId})).content,last.text);
  const registry=createDefaultSourceRegistry(),xls=await registry.get('xls').parse('sample.xls',await readFile(new URL('../ProjectMemorySystem/test/fixtures/docs/ProjectKnowledge/sample.xls',import.meta.url)));
  assert.ok(xls.blocks.some(b=>b.location.sheet==='Legacy'&&b.text.includes('legacy-marker\t42')));
  const row={text:'x'.repeat(700),kind:'table',headingPath:['wide'],location:{kind:'sheet',sheet:'wide',startRow:1,endRow:1,startColumn:'A',endColumn:'A',range:'A1:A1',headerRange:'A1:A1',headerText:'x'.repeat(700)}};
  assert.ok(chunkDocument('doc-test',[row],{targetChars:64,overlapChars:12,maxChars:96}).every(c=>c.text.length<=96));
  for(const c of chunkDocument('doc-test',[row],{targetChars:33,overlapChars:12,maxChars:66})){assert.ok(Number.isInteger(c.location.textStart));assert.ok(Number.isInteger(c.location.textEnd));assert.equal(c.text,row.text.slice(c.location.textStart,c.location.textEnd));}
});

test('M2 Chinese, mixed queries, symbols and assets return original excerpts and current citations',async t=>{
  const f=await fixture(t,{'Docs/wake.md':'---\naliases: [恢复显示]\nstatus: confirmed\n---\n# Power\n车辆休眠唤醒流程需要重新绑定显示窗口 UDisplayLifecycle /Game/UI/WBP_PowerStatus.WBP_PowerStatus\n\n'+Array.from({length:8},(_,i)=>`## Phase${i}\n唤醒阶段 ${'word '.repeat(30)}`).join('\n\n'),'ProjectKnowledge/systems/irrelevant.md':'# Noise\nUnrelated'});
  await indexDocuments(f.loaded);
  for(const query of ['唤','唤醒','休眠唤醒流程','UDisplayLifecycle 唤醒','/Game/UI/WBP_PowerStatus.WBP_PowerStatus','恢复显示']){
    const {results}=await hybridSearch(query,f.loaded);assert.ok(results.length,query);assert.ok(results.length<=2);assert.equal(results[0].path,'Docs/wake.md');assert.equal(results[0].sourceStatus,'current');assert.equal(results[0].metadata.status,'confirmed');
    const chunk=await read(f,'read_chunk',{chunkId:results[0].chunkId,expectedHash:results[0].sourceHash});assert.ok(chunk.content.includes(results[0].excerpt));
  }
  assert.deepEqual((await hybridSearch('QuantumFluxAbsentMarker',f.loaded)).results,[]);
  const old=(await hybridSearch('唤醒',f.loaded)).results[0];await f.put('Docs/wake.md','# Changed\nNew source');
  const changed=await hybridSearch('唤醒',f.loaded);assert.deepEqual(changed.results,[]);assert.ok(changed.warnings.some(w=>w.includes('changed')));await assert.rejects(read(f,'read_chunk',{chunkId:old.chunkId}),{code:'source_changed'});
});

test('M2 JSON/Proto cite original lines; readers reject invalid, stale, missing and foreign IDs',async t=>{
  const raw='\uFEFF{\r\n "name":"OriginalJsonMarker",\r\n "value":42\r\n}\r\n',proto='// line one\r\nsyntax = "proto3";\r\n\r\nmessage OriginalProtoMarker { string name = 1; }';
  const f=await fixture(t,{'Docs/source.json':raw,'Docs/source.proto':proto});await indexDocuments(f.loaded);
  for(const [query,original] of [['OriginalJsonMarker',raw],['OriginalProtoMarker',proto]]){
    const hit=(await hybridSearch(query,f.loaded)).results[0];assert.ok(hit,query);const c=await read(f,'read_chunk',{chunkId:hit.chunkId});assert.equal(c.content,original.slice(c.location.startOffset,c.location.endOffset));
    assert.equal((await read(f,'read_document',{documentId:hit.documentId,maxChunks:1})).chunks[0].chunkId,hit.chunkId);
    await assert.rejects(read(f,'read_document',{documentId:hit.documentId,expectedHash:'old'}),{code:'source_changed'});await assert.rejects(read(f,'read_document',{documentId:hit.documentId,offset:-1}),{code:'invalid_range'});
    await assert.rejects(read(f,'read_document',{documentId:hit.documentId,offset:1e20}),{code:'invalid_range'});
  }
  await assert.rejects(read(f,'read_document',{documentId:'../outside.md'}),{code:'invalid_source_id'});await assert.rejects(read(f,'read_document',{documentId:'doc-'+'0'.repeat(32)}),{code:'document_not_found'});
  const hit=(await hybridSearch('OriginalProtoMarker',f.loaded)).results[0];await rm(path.join(f.root,hit.path));await assert.rejects(read(f,'read_chunk',{chunkId:hit.chunkId}),{code:'source_missing'});
  const other=await fixture(t,{'Docs/source.json':raw});await indexDocuments(other.loaded);const foreign=(await hybridSearch('OriginalJsonMarker',other.loaded)).results[0];await assert.rejects(read(f,'read_chunk',{chunkId:foreign.chunkId}),{code:'chunk_not_found'});
});

test('M2 document pages are bounded and contiguous; linked source replacement is rejected',async t=>{
  const f=await fixture(t,{'Docs/long.md':'# One\n'+ 'a'.repeat(39900)+'\n\n# Two\n'+'b'.repeat(39900)+'\n\n# Three\nshort'},{targetChars:32000,overlapChars:0,maxChars:64000});
  await indexDocuments(f.loaded);const [doc]=await docs(f),page=await read(f,'read_document',{documentId:doc.id,maxChunks:20});
  assert.ok(page.chunks.reduce((sum,c)=>sum+c.text.length,0)<=64000);assert.ok(page.nextOffset>0);assert.deepEqual(page.chunks.map(c=>c.ordinal),Array.from({length:page.chunks.length},(_,i)=>i));
  const next=await read(f,'read_document',{documentId:doc.id,offset:page.nextOffset,maxChunks:20});assert.equal(next.chunks[0].ordinal,page.nextOffset);
  await rename(path.join(f.root,'Docs'),path.join(f.root,'ActualDocs'));await symlink(path.join(f.root,'ActualDocs'),path.join(f.root,'Docs'),process.platform==='win32'?'junction':'dir');await assert.rejects(read(f,'read_document',{documentId:doc.id}),{code:'path_denied'});
});

test('M2 version/policy changes invalidate reuse, deletion removes chunks, and legacy indexes stay queryable',async t=>{
  const f=await fixture(t,{'Docs/a.md':'# Stable\nLegacyMarker'}),first=await indexDocuments(f.loaded);await f.store.writeManifest(await f.store.createManifest(f.loaded,first.sources));assert.equal((await f.store.status(f.loaded)).status,'fresh');
  const second=await indexDocuments(f.loaded,{incremental:true,previousSources:first.sources});assert.deepEqual(second.unchangedSources,['Docs/a.md']);
  const documentFile=path.join(f.loaded.resolvedMemoryOutputRoot,'index/documents.jsonl'),document=JSON.parse((await readFile(documentFile,'utf8')).trim());document.parserVersion='old';await writeFile(documentFile,JSON.stringify(document)+'\n');assert.deepEqual((await indexDocuments(f.loaded,{incremental:true,previousSources:first.sources})).changedSources,['Docs/a.md']);
  f.loaded.config.memory.chunking.targetChars=160;assert.deepEqual((await indexDocuments(f.loaded,{incremental:true,previousSources:first.sources})).changedSources,['Docs/a.md']);
  const oldId=(await docs(f))[0].chunks[0].chunkId;await rm(path.join(f.root,'Docs/a.md'));const removed=await indexDocuments(f.loaded,{incremental:true,previousSources:first.sources});assert.deepEqual(removed.removedSources,['Docs/a.md']);assert.equal(removed.chunksIndexed,0);await assert.rejects(read(f,'read_chunk',{chunkId:oldId}),{code:'chunk_not_found'});
  const manifest=await f.store.readManifest();delete manifest.parserVersion;await f.store.writeManifest(manifest);assert.equal((await f.store.status(f.loaded)).status,'needs_full_rebuild');
  const legacyFile=path.join(f.loaded.resolvedMemoryOutputRoot,'index/fts.sqlite');await rm(legacyFile);const db=new DatabaseSync(legacyFile);db.exec("CREATE VIRTUAL TABLE documents_fts USING fts5(id UNINDEXED,path UNINDEXED,sourceType UNINDEXED,title,text); INSERT INTO documents_fts VALUES ('old','Docs/a.md','markdown','Legacy','LegacyMarker');");db.close();
  const legacy=await hybridSearch('LegacyMarker',f.loaded);assert.equal(legacy.results.length,1);assert.equal(legacy.results[0].sourceStatus,undefined);assert.ok(legacy.warnings.some(w=>w.includes('index_upgrade_required')));await assert.rejects(read(f,'read_document',{documentId:'doc-'+'0'.repeat(32)}),{code:'index_upgrade_required'});
});

// Minimal stored ZIP fixture: no installed package needed by the shipped test runner.
function zip(files) {
  const local=[],central=[];let offset=0;
  const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=value&1?(value>>>1)^0xedb88320:value>>>1;}return (value^0xffffffff)>>>0;};
  for(const [name,text] of Object.entries(files)){
    const filename=Buffer.from(name),data=Buffer.from(text),header=Buffer.alloc(30),entry=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc(data),14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc(data),16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
    local.push(header,filename,data);central.push(entry,filename);offset+=header.length+filename.length+data.length;
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(Buffer.concat(central).length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}

test('M2 identities survive edits and explicit page renames; duplicate bytes and copies stay separate',async t=>{
  const f=await fixture(t,{'Docs/a.md':'# Same\nidentical bytes','Docs/b.md':'# Same\nidentical bytes','Docs/page.md':'---\nid: wiki:power\n---\n# Power\noriginal'});
  const before=await docs(f),a=before.find(d=>d.path==='Docs/a.md'),b=before.find(d=>d.path==='Docs/b.md'),page=before.find(d=>d.path==='Docs/page.md');
  assert.notEqual(a.id,b.id);assert.equal(a.hash,b.hash);assert.notEqual(a.chunks[0].chunkId,b.chunks[0].chunkId);
  await f.put('Docs/a.md','# Same\nedited bytes');await rename(path.join(f.root,'Docs/page.md'),path.join(f.root,'Docs/renamed.md'));
  const after=await docs(f);assert.equal(after.find(d=>d.path==='Docs/a.md').id,a.id);assert.notEqual(after.find(d=>d.path==='Docs/a.md').hash,a.hash);
  assert.equal(after.find(d=>d.path==='Docs/renamed.md').id,page.id);assert.notEqual(documentIdentity(f.root+'copy','Docs/a.md'),a.id);
  f.loaded.resolvedKnowledgeRoots.push(path.join(f.root,'Docs'));assert.equal((await docs(f)).length,3);
  if(process.platform==='win32'){f.loaded.resolvedKnowledgeRoots.push(path.join(f.root,'DOCS'));assert.equal((await docs(f)).length,3);}
  await f.put('Docs/duplicate.md','---\nid: wiki:power\n---\nAnother page');await assert.rejects(indexDocuments(f.loaded),{code:'duplicate_document_id'});
});

test('M2 Wiki validates frontmatter and resolves links without claiming runtime verification',async t=>{
  const f=await fixture(t,{
    'Docs/a.md':'---\nid: start\ntitle: 起点\nstatus: confirmed\naliases: [启动]\ntags: [车辆]\nsources: [Source/Driver.cpp]\nsymbols: [UDriver]\nassets: [/Game/UI/WBP_Status]\nrelatedPages: [wiki:other]\n---\n# 起点\n[ok](b.md#唤醒) [absent](missing.md) [anchor](b.md#missing) [escape](../../outside.md) [web](https://example.test)\n[ref][target]\n\n[target]: b.md\n\n```md\n[ignored](phantom.md)\n```',
    'Docs/b.md':'---\nid: wiki:other\n---\n# 唤醒\n流程','Source/Driver.cpp':'void Driver() {}'
  });
  const a=(await docs(f)).find(d=>d.path==='Docs/a.md');assert.equal(a.title,'起点');assert.equal(a.metadata.status,'confirmed');
  const refs=a.metadata.references,ref=target=>refs.find(r=>r.target===target);
  assert.equal(ref('b.md#唤醒').status,'resolved');assert.match(ref('wiki:other').documentId,/^doc-/);
  assert.equal(ref('Source/Driver.cpp').status,'resolved');assert.equal(ref('UDriver').status,'unverified');assert.equal(ref('/Game/UI/WBP_Status').reason,'requires_ue_snapshot');
  assert.equal(ref('missing.md').status,'missing');assert.equal(ref('b.md#missing').status,'missing_anchor');assert.equal(ref('../../outside.md').status,'outside_project');assert.equal(ref('https://example.test').status,'external');assert.equal(ref('phantom.md'),undefined);
  assert.equal(parseWiki('plain').metadata.status,'draft');
  for(const body of ['status: verified','tags: scalar','id: [wrong]','title: a\ntitle: b','aliases: &aliases [a]\ntags: *aliases','[one, two]'])assert.throws(()=>parseWiki(`---\n${body}\n---\ntext`));
  assert.throws(()=>parseWiki('---\nid: not-closed'));
});

test('M2 Markdown chunks retain BOM/CRLF offsets, sections, fences, lists and tables',()=>{
  const raw='\uFEFF---\r\nid: example\r\n---\r\n# First\r\n\r\nA paragraph.\r\n\r\n```cpp\r\n# not a heading\r\nint x;\r\n```\r\n\r\n- alpha\r\n- beta\r\n\r\n| A | B |\r\n|---|---|\r\n| C | D |\r\n\r\n## Second\r\nAnother paragraph.\r\n';
  const policy={targetChars:64,overlapChars:16,maxChars:140},parsed=parseWiki(raw),chunks=chunkDocument('doc-test',parsed.blocks,policy,raw);
  assert.deepEqual(parsed.metadata.headings,['First','Second']);
  for(const chunk of chunks){assert.equal(chunk.text,raw.slice(chunk.location.startOffset,chunk.location.endOffset));assert.ok(chunk.location.startLine>=4);assert.ok(chunk.text.length<=140);}
  const code=parsed.blocks.find(c=>c.kind==='code');assert.equal(code.location.startLine,8);assert.equal(code.location.endLine,11);
  assert.ok(chunks.some(c=>c.text.includes('```cpp\r\n# not a heading\r\nint x;\r\n```')));
  assert.ok(chunks.some(c=>c.text.includes('- alpha\r\n- beta')));assert.ok(chunks.some(c=>c.text.includes('| A | B |\r\n|---|---|\r\n| C | D |')));assert.deepEqual(chunks.at(-1).headingPath,['First','Second']);
  const unchanged=chunks.find(c=>c.text.includes('Another paragraph.')),edited=raw.replace('A paragraph.','Changed paragraph.');
  assert.equal(chunkDocument('doc-test',parseWiki(edited).blocks,policy,edited).find(c=>c.text.includes('Another paragraph.')).chunkId,unchanged.chunkId);
});

test('M2 oversized Unicode blocks stay bounded with valid overlap and source offsets',()=>{
  const raw='唤醒😀'.repeat(300),policy={targetChars:64,overlapChars:12,maxChars:96},chunks=chunkDocument('doc-test',textBlocks(raw),policy,raw);assert.ok(chunks.length>10);
  let previous;for(const c of chunks){assert.ok(c.text.length<=96);assert.ok(c.text.isWellFormed());assert.equal(c.text,raw.slice(c.location.startOffset,c.location.endOffset));if(previous){assert.ok(c.location.startOffset<previous.location.endOffset);assert.ok(c.location.endOffset>previous.location.endOffset);}previous=c;}
  assert.equal(chunks.at(-1).location.endOffset,raw.length);assert.throws(()=>chunkPolicy({memory:{chunking:{targetChars:32,overlapChars:32}}}));
});

test('M2 relevance precedes directory hints and invalid chunk policy fails the build',async t=>{
  const f=await fixture(t,{'Docs/precise.md':'# Calibration\nExactQueryMarker WakeMarker','ProjectKnowledge/systems/noise.md':'# Partial\nExactQueryMarker unrelated content'});
  await indexDocuments(f.loaded);assert.equal((await hybridSearch('ExactQueryMarker WakeMarker',f.loaded)).results[0].path,'Docs/precise.md');
  f.loaded.config.memory.chunking.overlapChars=120;await assert.rejects(indexDocuments(f.loaded),/Invalid memory.chunking/);
});

test('M2 DOCX cites original paragraphs including blank and self-closing paragraphs',async t=>{
  const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Wake</w:t></w:r></w:p><w:p><w:r><w:t>UDisplay</w:t></w:r><w:r><w:t>Lifecycle &#x5524;&#x9192; &amp;lt;</w:t></w:r></w:p><w:p></w:p><w:p><w:r><w:t>'+('段落😀'.repeat(100))+'</w:t></w:r></w:p></w:body></w:document>';
  const f=await fixture(t,{'Docs/wake.docx':zip({'word/document.xml':xml})}),[doc]=await docs(f);
  assert.equal(doc.metadata.paragraphCount,5);assert.ok(doc.text.includes('UDisplayLifecycle 唤醒 &lt;'));assert.equal(doc.chunks[0].location.startParagraph,2);assert.equal(doc.chunks[0].location.endParagraph,3);
  const long=doc.chunks.filter(c=>c.location.startParagraph===5);assert.ok(long.length>1);
  for(const c of long){assert.ok(c.text.length<=240);assert.equal(c.text,('段落😀'.repeat(100)).slice(c.location.textStart,c.location.textEnd));assert.equal(c.location.endParagraph,5);}
  await indexDocuments(f.loaded);const result=await read(f,'read_chunk',{chunkId:long[0].chunkId,expectedHash:doc.hash});assert.equal(result.content,long[0].text);assert.equal(result.location.part,'word/document.xml');
});
