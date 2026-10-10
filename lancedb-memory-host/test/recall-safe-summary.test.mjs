import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MemoryCoordinator} from '../src/memory-runtime.ts';
import {MemoryStore} from '../memory-lancedb-pro/src/store.ts';
import {ProjectionRefResolver} from '../src/projection-ref-resolver.ts';
import {preparePublicRecallResults,SAFE_SUMMARY_BUDGET_MS,SAFE_SUMMARY_MAX_READS} from '../src/safe-summary-recall.ts';
import {formatPublicMemories,publicMemoryResult} from '../src/public-response.ts';
import {createWritePlaneAdapter} from '../src/write-plane-adapter.ts';
import {MEMORY_EVENT_CONSUMERS} from '../src/consumer-queue.ts';
import {logicalProjectionChecksum} from '../../mqe/projection/projection_contract.mjs';
const WITHHELD='Content withheld by public safety policy.';
const hash=x=>createHash('sha256').update(x).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const ref=n=>'rr1_'+hash('synthetic-'+n);
const entry=(n,overrides={})=>({id:id(n),text:'Evidence '+n+' from D:/synthetic/private/source.txt',vector:[1,0],category:'fact',scope:'global',importance:.7,timestamp:1,metadata:'{}',...overrides});
function fixture(t,changes=[{}]){
 const root=fs.mkdtempSync(path.join(tmpdir(),'safe-summary-handler-'));
 assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('safe-summary-handler-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'data/projection');fs.mkdirSync(dir,{recursive:true});
 const dbPath=path.join(dir,'staging.sqlite'),db=new DatabaseSync(dbPath);
 db.exec(fs.readFileSync(new URL('../../mqe/projection/schema.sql',import.meta.url),'utf8'));
 const meta={schema_version:'2.0.0',checksum_contract:'logical-tables-v2-real17',ref_key_id:'rk1_'+'c'.repeat(32),corpus_epoch:'0'.repeat(16),checksum:'sha256:'+'0'.repeat(64),raw_trace_included:'0',built_at:'2026-10-07T00:00:00Z',mode:'test'};
 for(const[k,v]of Object.entries(meta))db.prepare('INSERT INTO projection_meta(key,value) VALUES(?,?)').run(k,v);
 const entries=changes.map((change,index)=>entry(index+1,change.entry));
 for(let i=0;i<changes.length;i++){
  const current=entries[i];
  const r={record_id:current.id,record_ref:ref(i+1),origin:'lancedb',kind:'fact',recorded_time:'2026-10-07T00:00:00Z',content_hash:'sha256:'+hash(current.text),safe_excerpt:'Reviewed safe summary '+(i+1)+'.',safe_excerpt_status:'accepted',source_pointer:'synthetic:fixture',search_text:'synthetic',active:1,compiled_at:'2026-10-07T00:00:00Z',answerability:'memory_allowed',authority_resolution:'resolved',status:'active',scope:'global',...changes[i].projection};
  const keys=Object.keys(r);db.prepare('INSERT INTO records('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>r[k]));
 }
 const checksum=logicalProjectionChecksum(db),epoch=checksum.slice(7,23);
 db.prepare("UPDATE projection_meta SET value=? WHERE key='checksum'").run(checksum);db.prepare("UPDATE projection_meta SET value=? WHERE key='corpus_epoch'").run(epoch);db.close();
 const filename='memory_index.'+epoch+'.sqlite';fs.renameSync(dbPath,path.join(dir,filename));
 const pointer={schema_version:'2.0.0',ref_key_id:meta.ref_key_id,corpus_epoch:epoch,filename,checksum,updated_at:'2026-10-07T00:00:00Z'};
 const pointerPath=path.join(dir,'CURRENT.json');fs.writeFileSync(pointerPath,JSON.stringify(pointer));
 return {root,entries,resolver:new ProjectionRefResolver(root),results:entries.map(e=>({entry:{...e,vector:[...e.vector]},fusionScore:.7,sources:['bm25']})),flip(){fs.writeFileSync(pointerPath,JSON.stringify({...pointer,updated_at:'2026-10-07T00:00:01Z'}));}};
}
function runtime(entries){
 const rows=new Map(entries.map(e=>[e.id,{...e,vector:[...e.vector]}]));const calls=[];
 const state={onRead:null,onVector:null};
 const store={list:async()=>[...rows.values()],getById:async(id,budget,includeVector)=>{calls.push({id,budget,includeVector});if(state.onRead)return state.onRead(id,budget,includeVector);const e=rows.get(id);return e?{...e,vector:[]}:null;},
 vectorSearch:async()=>state.onVector?state.onVector():[],bm25Search:async()=>[],
 store:async e=>{const v={timestamp:1,...e};rows.set(v.id,v);return v;},
 update:async(id,u)=>{const e=rows.get(id);if(!e)return null;const v={...e,...u};rows.set(id,v);return v;},
 delete:async id=>rows.delete(id)};
 const c=new MemoryCoordinator(store,async()=>[1,0],{bm25DeadlineMs:250,nativeAdmissionDeadlineMs:250});
 return {c,store,rows,calls,state};
}
async function prepare(f,r,enabled=true){return preparePublicRecallResults(f.results,20,r.c,f.resolver,enabled);}
test('default off keeps old public rows and never reads primary',async t=>{
 const f=fixture(t),r=runtime(f.entries);const p=await prepare(f,r,false);
 assert.deepEqual(p.finalize(),f.results.map(x=>publicMemoryResult(x,f.resolver.recordRefForId(x.entry.id))));assert.equal(r.calls.length,0);
});
test('real coordinator/resolver/formatter pipeline displays only labelled reviewed summary and legal ref',async t=>{
 const f=fixture(t),r=runtime(f.entries);const p=await prepare(f,r);
 const rows=p.finalize(),text=formatPublicMemories(rows);
 assert.equal(rows[0].safe_excerpt,'Safe summary (not full text): Reviewed safe summary 1.');
 assert.deepEqual(Object.keys(rows[0]),['record_ref','memory_kind','safe_excerpt','sources']);
 assert.ok(text.includes(ref(1)));assert.ok(!text.includes(id(1)));assert.ok(!text.includes('D:/'));
 assert.equal(r.calls.length,1);assert.equal(r.calls[0].includeVector,false);
 assert.ok(r.calls[0].budget>0&&r.calls[0].budget<=SAFE_SUMMARY_BUDGET_MS);
});
test('safe full text stays unchanged and costs no primary read',async t=>{
 const f=fixture(t,[{entry:{text:'Already safe original.'}}]),r=runtime(f.entries);
 assert.equal((await prepare(f,r)).finalize()[0].safe_excerpt,'Already safe original.');assert.equal(r.calls.length,0);
});
test('unapproved rows do not consume the bounded read slots ahead of an approved candidate',async t=>{
 const f=fixture(t,[{projection:{safe_excerpt_status:'rejected_unstructured'}},{projection:{safe_excerpt_status:'rejected_unstructured'}},{}]),r=runtime(f.entries);
 const rows=(await prepare(f,r)).finalize();assert.deepEqual(rows.map(x=>x.safe_excerpt),[WITHHELD,WITHHELD,'Safe summary (not full text): Reviewed safe summary 3.']);assert.equal(r.calls.length,1);
});
test('one recall reads at most two eligible rows',async t=>{
 const f=fixture(t,[{},{},{}]),r=runtime(f.entries);const rows=(await prepare(f,r)).finalize();
 assert.equal(r.calls.length,SAFE_SUMMARY_MAX_READS);assert.equal(rows[2].safe_excerpt,WITHHELD);
});
test('private, missing scope and tombstone primary rows remain withheld',async t=>{
 for(const scope of ['agent:private',undefined,'__memory_deleted__']){
  const f=fixture(t),r=runtime(f.entries);r.rows.set(id(1),{...f.entries[0],scope});
  assert.equal((await prepare(f,r)).finalize()[0].safe_excerpt,WITHHELD);
 }
});
test('cached text that disagrees with primary cannot consume the old reviewed summary',async t=>{
 const f=fixture(t),r=runtime(f.entries);r.rows.set(id(1),{...f.entries[0],text:'changed primary'});
 assert.equal((await prepare(f,r)).finalize()[0].safe_excerpt,WITHHELD);
});
test('cache invalidation between prepare and publication rejects the receipt',async t=>{
 const f=fixture(t),r=runtime(f.entries);const p=await prepare(f,r);r.c.clearRecallCache();
 assert.deepEqual(p.finalize(),[]);assert.equal(p.invalidated,true);
});
test('forget after preparation refuses public summary',async t=>{
 const f=fixture(t),r=runtime(f.entries);await r.c.initialize();const p=await prepare(f,r);await r.c.forget(id(1));
 assert.deepEqual(p.finalize(),[]);assert.equal(p.invalidated,true);
});
test('same-epoch pointer identity flip between prepare and publication refuses summary',async t=>{
 const f=fixture(t),r=runtime(f.entries);const p=await prepare(f,r);f.flip();
 assert.deepEqual(p.finalize(),[]);assert.equal(p.invalidated,true);
});
test('mutation during native read is refused even when text is unchanged',async t=>{
 const f=fixture(t),r=runtime(f.entries);await r.c.initialize();
 r.state.onRead=async()=>{await r.c.update(id(1),{importance:.8});return r.rows.get(id(1));};
 assert.deepEqual((await prepare(f,r)).finalize(),[]);
});
test('expired or unsafe reviewed projection cannot trigger primary reads',async t=>{
 for(const projection of [{valid_to:'2020-01-01'},{superseded_by:'synthetic-successor'},{safe_excerpt:'Open D:/synthetic/private/file'}]){
  const f=fixture(t,[{projection}]),r=runtime(f.entries);
  assert.equal((await prepare(f,r)).finalize()[0].safe_excerpt,WITHHELD);assert.equal(r.calls.length,0);
 }
});
test('two primary reads share shrinking time and a finite total wall budget',async t=>{
 const f=fixture(t,[{},{}]),r=runtime(f.entries);r.state.onRead=async id=>{await pause(20);return r.rows.get(id);};
 const start=performance.now();const p=await prepare(f,r);const rows=p.finalize();
 assert.equal(r.calls.length,2);assert.ok(r.calls[1].budget<r.calls[0].budget);
 assert.ok(performance.now()-start<SAFE_SUMMARY_BUDGET_MS+100);assert.ok(rows.every(x=>x.safe_excerpt.startsWith('Safe summary')));
});
test('native gate admission waiting is charged to the same 200ms recall budget',async t=>{
 const f=fixture(t,[{},{}]),r=runtime(f.entries),d=deferred(),entered=deferred();
 r.state.onVector=async()=>{entered.resolve();return d.promise;};
 const busy=r.c.prewarmVectorPath();await entered.promise;
 const start=performance.now();const p=await prepare(f,r);
 assert.ok(performance.now()-start<SAFE_SUMMARY_BUDGET_MS+100);assert.equal(r.calls.length,0);
 assert.ok(p.finalize().every(x=>x.safe_excerpt===WITHHELD));
 assert.equal(r.c.diagnostics.nativeRetrievalGate.pending,0);d.resolve([]);await busy;
});
test('native late completion stays tracked and cannot publish a delayed summary',async t=>{
 const f=fixture(t,[{},{}]),r=runtime(f.entries),d=deferred();r.state.onRead=async()=>d.promise;
 const p=await prepare(f,r);assert.equal(r.calls.length,1);assert.equal(r.c.diagnostics.primaryRead.timedOutInFlight,1);
 assert.ok(p.finalize().every(x=>x.safe_excerpt===WITHHELD));d.resolve(f.entries[0]);await pause(5);
 assert.equal(r.c.diagnostics.nativeRetrievalGate.locked,false);assert.ok(p.finalize().every(x=>x.safe_excerpt===WITHHELD));
});
test('real getById initialization wait is within the coordinator watchdog and retains gate until settlement',async t=>{
 const f=fixture(t),r=runtime(f.entries),d=deferred();let materialized=0;
 const query={select:()=>query,where:()=>query,limit:()=>query,toArray:async()=>{materialized++;return [f.entries[0]];}};
 const fake={ensureInitialized:async()=>d.promise,table:{query:()=>query}};
 r.state.onRead=(...args)=>MemoryStore.prototype.getById.call(fake,...args);
 const start=performance.now();const p=await prepare(f,r);
 assert.ok(performance.now()-start<SAFE_SUMMARY_BUDGET_MS+100);assert.equal(p.finalize()[0].safe_excerpt,WITHHELD);assert.equal(p.invalidated,false);
 assert.equal(r.c.diagnostics.nativeRetrievalGate.locked,true);d.resolve();await pause(5);
 assert.equal(r.c.diagnostics.nativeRetrievalGate.locked,false);assert.equal(materialized,0);
});
test('canonical adapter global save, update and forget invalidate issued receipts',async()=>{
 for(const op of ['save','update','forget']){
  const r=runtime([entry(1)]);await r.c.initialize();const receipt=await r.c.readVisiblePrimary(id(1),entry(1).text);assert.ok(receipt);
  const adapter=createWritePlaneAdapter(r.store,r.c);
  if(op==='save')await adapter.commitSave({...entry(2),metadata:'{}'});
  if(op==='update')await adapter.commitUpdate({memoryId:id(1),importance:.8,metadata:'{}'});
  if(op==='forget')await adapter.commitForget({memoryId:id(1),tombstoneText:'forgotten',metadata:'{}'});
  assert.equal(r.c.visiblePrimaryIsCurrent(receipt),false,op);
 }
});
function embeddedMetadata(memory,mutationId){
 const snapshot={category:memory.category,scope:memory.scope,importance:memory.importance,text_sha256:hash(memory.text)};
 const event={schema:'memory-mutation-event/v2',event_id:id(91),mutation_id:mutationId,sequence:1,operation:'update',effect:'updated',memory_id:memory.id,occurred_at:'2026-10-07T00:00:00Z',request_digest:'a'.repeat(64),companion:'no_op',before:snapshot,after:snapshot};
 return JSON.stringify({_memory_write_plane:{schema:'memory-write-plane-commit/v2',idempotency_hash:'b'.repeat(64),request_digest:event.request_digest,event,delivery:{status:'pending',consumers:[...MEMORY_EVENT_CONSUMERS]}}});
}
test('global and tombstone outbox acknowledgement both invalidate issued receipts',async()=>{
 const global=entry(1),tombstone=entry(2,{scope:'__memory_deleted__',text:'forgotten'}),mutationId=id(90);
 global.metadata=embeddedMetadata(global,mutationId);tombstone.metadata=embeddedMetadata(tombstone,mutationId);
 const r=runtime([global,tombstone]);await r.c.initialize();const adapter=createWritePlaneAdapter(r.store,r.c);
 const first=await r.c.readVisiblePrimary(id(1),global.text);assert.ok(first);
 await adapter.markOutboxDelivered(id(1),mutationId,'2026-10-07T00:00:01Z');
 assert.equal(r.c.visiblePrimaryIsCurrent(first),false);
 const second=await r.c.readVisiblePrimary(id(1),global.text);assert.ok(second);
 await adapter.markOutboxDelivered(id(2),mutationId,'2026-10-07T00:00:01Z');
 assert.equal(r.c.visiblePrimaryIsCurrent(second),false);assert.equal(r.rows.get(id(2)).scope,'__memory_deleted__');
 assert.equal(await r.c.readVisiblePrimary(id(2),tombstone.text),null);
});
test('handler flag is host-owned, evaluation bypasses summaries, and disabled path has no new await',()=>{
 const source=fs.readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
 assert.ok(source.includes('process.env.MEMORY_SAFE_SUMMARY_ENABLED === "1"'));
 assert.ok(source.includes('SAFE_SUMMARY_ENABLED && sessionLeaseOwner === null'));
 const start=source.indexOf('const preparedPublicResults ='),finish=source.indexOf('const retrievalMeta =',start),section=source.slice(start,finish);
 assert.ok(section.includes('? await preparePublicRecallResults('));assert.ok(section.includes(': null'));
 assert.equal(section.slice(section.indexOf('preparedPublicResults.finalize()')).includes('await '),false);
});

test('a safe full-text row forgotten while another summary awaits is not published',async t=>{
 const f=fixture(t,[{entry:{text:'A public fact that was forgotten.'}},{}]),r=runtime(f.entries),d=deferred(),entered=deferred();
 await r.c.initialize();r.state.onRead=async()=>{entered.resolve();return d.promise;};
 const pending=prepare(f,r);await entered.promise;await r.c.forget(id(1));d.resolve(f.entries[1]);
 const p=await pending;assert.deepEqual(p.finalize(),[]);assert.equal(p.invalidated,true);
});

test('finalize after the 200ms budget returns original withheld despite valid receipts',async t=>{
 const f=fixture(t),r=runtime(f.entries),started=performance.now();
 const p=await prepare(f,r);
 assert.equal(r.calls.length,1);
 const receipt=await r.c.readVisiblePrimary(id(1),f.entries[0].text);
 assert.ok(receipt);assert.equal(r.c.visiblePrimaryIsCurrent(receipt),true);
 assert.equal(p.finalize()[0].safe_excerpt,'Safe summary (not full text): Reviewed safe summary 1.');
 await pause(Math.max(1,SAFE_SUMMARY_BUDGET_MS-(performance.now()-started)+30));
 assert.ok(performance.now()-started>=SAFE_SUMMARY_BUDGET_MS);
 assert.equal(r.c.visiblePrimaryIsCurrent(receipt),true);
 const rows=p.finalize();
 assert.equal(p.invalidated,false);assert.equal(rows.length,1);
 assert.equal(rows[0].safe_excerpt,WITHHELD);
 assert.deepEqual(rows,[publicMemoryResult(f.results[0],f.resolver.recordRefForId(id(1)))]);
});

// Synthetic timing control around the existing synchronous ref lookup.
// This exercises budget attribution; it is not a production cold-load benchmark.
function syntheticColdReferenceLoad(f, afterLoad = () => {}) {
 const originalLookup = f.resolver.recordRefForId.bind(f.resolver);
 let cold = true;
 const observed = { calls: 0, elapsedMs: 0 };
 f.resolver.recordRefForId = value => {
  if (!cold) return originalLookup(value);
  cold = false;
  observed.calls += 1;
  const started = performance.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SAFE_SUMMARY_BUDGET_MS + 50);
  const result = originalLookup(value);
  observed.elapsedMs = performance.now() - started;
  afterLoad();
  return result;
 };
 return observed;
}

test('existing cold ref lookup over 200ms preserves the first enabled summary and full added budget', async t => {
 const baseline = fixture(t), baselineRuntime = runtime(baseline.entries);
 const baselineCold = syntheticColdReferenceLoad(baseline);
 const oldRows = (await prepare(baseline, baselineRuntime, false)).finalize();
 assert.ok(baselineCold.elapsedMs > SAFE_SUMMARY_BUDGET_MS);
 assert.equal(oldRows[0].safe_excerpt, WITHHELD);
 assert.equal(baselineRuntime.calls.length, 0);

 const f = fixture(t), r = runtime(f.entries), cold = syntheticColdReferenceLoad(f);
 const primaryBudgets = [], originalRead = r.c.readVisiblePrimary.bind(r.c);
 r.c.readVisiblePrimary = (...args) => { primaryBudgets.push(args[2]); return originalRead(...args); };
 const p = await prepare(f, r);
 assert.ok(cold.elapsedMs > SAFE_SUMMARY_BUDGET_MS);
 assert.equal(cold.calls, 1);
 assert.equal(r.calls.length, 1, 'baseline ref loading must not spend the added primary-read budget');
 assert.equal(primaryBudgets.length, 1);
 assert.ok(primaryBudgets[0] >= SAFE_SUMMARY_BUDGET_MS - 40);
 assert.ok(primaryBudgets[0] <= SAFE_SUMMARY_BUDGET_MS);
 assert.ok(r.calls[0].budget <= SAFE_SUMMARY_BUDGET_MS);
 assert.equal(p.invalidated, false);
 assert.equal(p.finalize()[0].safe_excerpt, 'Safe summary (not full text): Reviewed safe summary 1.');
});

test('after cold baseline work a primary read exceeding the added budget still returns original withheld', async t => {
 const f = fixture(t), r = runtime(f.entries), cold = syntheticColdReferenceLoad(f), d = deferred();
 r.state.onRead = async () => d.promise;
 const p = await prepare(f, r);
 assert.ok(cold.elapsedMs > SAFE_SUMMARY_BUDGET_MS);
 assert.equal(r.calls.length, 1);
 assert.ok(r.calls[0].budget > 0 && r.calls[0].budget <= SAFE_SUMMARY_BUDGET_MS);
 assert.equal(r.c.diagnostics.primaryRead.timedOutInFlight, 1);
 assert.equal(p.finalize()[0].safe_excerpt, WITHHELD);
 assert.equal(p.invalidated, false);
 d.resolve(f.entries[0]);
 await pause(5);
 assert.equal(r.c.diagnostics.nativeRetrievalGate.locked, false);
 assert.equal(p.finalize()[0].safe_excerpt, WITHHELD);
});

test('a first summary after cold baseline work expires at finalize after another 200ms', async t => {
 const f = fixture(t), r = runtime(f.entries), cold = syntheticColdReferenceLoad(f);
 const p = await prepare(f, r);
 assert.ok(cold.elapsedMs > SAFE_SUMMARY_BUDGET_MS);
 assert.equal(r.calls.length, 1);
 assert.equal(p.finalize()[0].safe_excerpt, 'Safe summary (not full text): Reviewed safe summary 1.');
 await pause(SAFE_SUMMARY_BUDGET_MS + 30);
 const rows = p.finalize();
 assert.equal(rows.length, 1);
 assert.equal(rows[0].safe_excerpt, WITHHELD);
 assert.equal(p.invalidated, false);
});

test('the publication fence begins before cold baseline loading and catches cache invalidation there', async t => {
 const f = fixture(t), r = runtime(f.entries);
 const cold = syntheticColdReferenceLoad(f, () => r.c.clearRecallCache());
 const p = await prepare(f, r);
 assert.ok(cold.elapsedMs > SAFE_SUMMARY_BUDGET_MS);
 assert.equal(r.calls.length, 0);
 assert.deepEqual(p.finalize(), []);
 assert.equal(p.invalidated, true);
});

test('the projection snapshot begins before cold baseline loading and catches a pointer flip there', async t => {
 const f = fixture(t), r = runtime(f.entries);
 const cold = syntheticColdReferenceLoad(f, () => f.flip());
 const p = await prepare(f, r);
 assert.ok(cold.elapsedMs > SAFE_SUMMARY_BUDGET_MS);
 assert.equal(r.calls.length, 0);
 assert.deepEqual(p.finalize(), []);
 assert.equal(p.invalidated, true);
});

test('new summary setup exceeding 200ms stays charged despite excluding cold baseline work', async t => {
 const f = fixture(t), r = runtime(f.entries);
 const originalSnapshot = f.resolver.beginSummarySnapshot.bind(f.resolver);
 let setupElapsedMs = 0;
 f.resolver.beginSummarySnapshot = () => {
  const started = performance.now();
  const snapshot = originalSnapshot();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SAFE_SUMMARY_BUDGET_MS + 50);
  setupElapsedMs = performance.now() - started;
  return snapshot;
 };
 const p = await prepare(f, r);
 assert.ok(setupElapsedMs > SAFE_SUMMARY_BUDGET_MS);
 assert.equal(r.calls.length, 0, 'new fence/snapshot setup must still consume the added 200ms budget');
 assert.equal(p.invalidated, false);
 assert.equal(p.finalize()[0].safe_excerpt, WITHHELD);
});
