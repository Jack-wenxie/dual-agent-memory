import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemoryCoordinator} from '../src/memory-runtime.ts';
import {MemoryStore,DELETED_MEMORY_SCOPE,isNativeQueryTimeoutError} from '../memory-lancedb-pro/src/store.ts';
const ID='00000000-0000-4000-8000-000000000001';
const make=overrides=>({id:ID,text:'unchanged safe primary text',vector:[1,0],category:'fact',scope:'global',importance:.7,timestamp:1,metadata:'{}',...overrides});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function setup(overrides={},options={}){
 const store={list:async()=>[make()],vectorSearch:async()=>[],bm25Search:async()=>[],store:async e=>make(e),update:async(id,u)=>make({id,...u}),delete:async()=>true,getById:async()=>make(),...overrides};
 return {store,c:new MemoryCoordinator(store,async()=>[1,0],{bm25DeadlineMs:40,nativeAdmissionDeadlineMs:20,circuitCooldownMs:10,...options})};
}
test('fresh primary is bounded, vector-free and returns an unforgeable freshness receipt',async()=>{
 let args;const {c}=setup({getById:async(...a)=>{args=a;return make();}});await c.initialize();
 const v=await c.readVisiblePrimary(ID,make().text);assert.ok(v);assert.equal(c.visiblePrimaryIsCurrent(v),true);
 assert.equal(args[0],ID);assert.equal(args[2],false);assert.ok(args[1]>0&&args[1]<=40);
 assert.equal(c.visiblePrimaryIsCurrent({entry:make()}),false);
 assert.throws(()=>{v.entry.scope='private';});
 c.clearRecallCache();assert.equal(c.visiblePrimaryIsCurrent(v),false);
});
test('changed text, private scope, tombstone, absent and mismatched ids stay withheld',async()=>{
 for(const row of [make({text:'new text'}),make({scope:'agent:private'}),make({scope:DELETED_MEMORY_SCOPE}),null,make({id:ID.slice(0,-1)+'2'})]){
  const {c}=setup({getById:async()=>row});await c.initialize();assert.equal(await c.readVisiblePrimary(ID,make().text),null);
 }
});
test('absent exact-reader and invalid selectors fail closed without native work',async()=>{
 const {c}=setup({getById:undefined});assert.equal(await c.readVisiblePrimary(ID,make().text),null);
 let calls=0;const second=setup({getById:async()=>{calls++;return make();}}).c;
 assert.equal(await second.readVisiblePrimary('',make().text),null);assert.equal(calls,0);
});
test('cache generation change while exact read is pending rejects the result',async()=>{
 const d=deferred(), entered=deferred();const {c}=setup({getById:async()=>{entered.resolve();return d.promise;}});
 const read=c.readVisiblePrimary(ID,make().text);await entered.promise;c.clearRecallCache();d.resolve(make());assert.equal(await read,null);
});
test('an update beginning during exact read invalidates its receipt before the write completes',async()=>{
 const readD=deferred(),readEntered=deferred(),writeD=deferred(),writeEntered=deferred();
 const {c}=setup({getById:async()=>{readEntered.resolve();return readD.promise;},update:async()=>{writeEntered.resolve();return writeD.promise;}});
 await c.initialize();const read=c.readVisiblePrimary(ID,make().text);await readEntered.promise;
 const write=c.update(ID,{importance:.8});await writeEntered.promise;readD.resolve(make());assert.equal(await read,null);
 writeD.resolve(make({importance:.8}));await write;
});
test('active mutation refuses new reads without blocking the write',async()=>{
 const d=deferred(),entered=deferred();let reads=0;
 const {c}=setup({getById:async()=>{reads++;return make();},update:async()=>{entered.resolve();return d.promise;}});
 await c.initialize();const write=c.update(ID,{scope:DELETED_MEMORY_SCOPE});await entered.promise;
 assert.equal(await c.readVisiblePrimary(ID,make().text),null);assert.equal(reads,0);
 d.resolve(make({scope:DELETED_MEMORY_SCOPE}));await write;
});
test('forget invalidates a previously issued receipt',async()=>{
 const {c}=setup();await c.initialize();const v=await c.readVisiblePrimary(ID,make().text);assert.ok(v);
 await c.forget(ID);assert.equal(c.visiblePrimaryIsCurrent(v),false);
});
test('late native completion retains the real gate, prevents stacking and leaves retrieval branches untouched',async()=>{
 const d=deferred();let reads=0;const {c}=setup({getById:async()=>{reads++;return d.promise;}},{bm25DeadlineMs:20});
 assert.equal(await c.readVisiblePrimary(ID,make().text),null);
 assert.equal(c.diagnostics.nativeRetrievalGate.locked,true);assert.equal(c.diagnostics.primaryRead.timedOutInFlight,1);
 assert.equal(await c.readVisiblePrimary(ID,make().text),null);assert.equal(reads,1);
 assert.equal(c.diagnostics.circuits.vector.consecutiveFailures,0);assert.equal(c.diagnostics.circuits.bm25.consecutiveFailures,0);
 d.resolve(make());await pause(5);
 assert.equal(c.diagnostics.nativeRetrievalGate.locked,false);assert.equal(c.diagnostics.primaryRead.timedOutInFlight,0);
});
test('native gate contention has a bounded admission wait and never starts the denied exact read',async()=>{
 const d=deferred(),entered=deferred();let reads=0;
 const {c}=setup({vectorSearch:async()=>{entered.resolve();return d.promise;},getById:async()=>{reads++;return make();}});
 const busy=c.prewarmVectorPath();await entered.promise;
 assert.equal(await c.readVisiblePrimary(ID,make().text),null);assert.equal(reads,0);
 assert.equal(c.diagnostics.primaryRead.timing.final_branch,'timeout');d.resolve([]);await busy;
});
test('backend errors are withheld and do not change vector or BM25 circuit state',async()=>{
 const {c}=setup({getById:async()=>{throw new Error('synthetic private error');}});
 assert.equal(await c.readVisiblePrimary(ID,make().text),null);
 assert.equal(c.diagnostics.primaryRead.timing.final_branch,'error');
 assert.equal(c.diagnostics.circuits.bm25.consecutiveFailures,0);
});
test('real store exact-reader forwards SDK timeout, omits vector payload and preserves legacy vector return',async()=>{
 let selected,options;const row=make();
 const query={select:columns=>{selected=columns;return query;},where:()=>query,limit:()=>query,toArray:async o=>{options=o;return [row];}};
 const fake={ensureInitialized:async()=>{},table:{query:()=>query}};
 const exact=await MemoryStore.prototype.getById.call(fake,ID,40,false);
 assert.equal(exact.text,row.text);assert.deepEqual(exact.vector,[]);assert.ok(options.timeoutMs>0&&options.timeoutMs<=40);
 assert.ok(selected.includes('text'));assert.ok(!selected.includes('vector'));
 selected=undefined;options=undefined;const legacy=await MemoryStore.prototype.getById.call(fake,ID);
 assert.deepEqual(legacy.vector,[1,0]);assert.equal(selected,undefined);assert.equal(options,undefined);
});
test('time spent initializing consumes the store exact-read deadline',async()=>{
 let calls=0;const query={select:()=>query,where:()=>query,limit:()=>query,toArray:async()=>{calls++;return [make()];}};
 const fake={ensureInitialized:async()=>pause(8),table:{query:()=>query}};
 await assert.rejects(()=>MemoryStore.prototype.getById.call(fake,ID,1,false),isNativeQueryTimeoutError);assert.equal(calls,0);
});

test('strict primary store reads preserve unknown scope as unavailable while legacy reads keep their old default',async()=>{
 const query={select:()=>query,where:()=>query,limit:()=>query,toArray:async()=>[make({scope:undefined})]};
 const fake={ensureInitialized:async()=>{},table:{query:()=>query}};
 const strict=await MemoryStore.prototype.getById.call(fake,ID,40,false);
 const legacy=await MemoryStore.prototype.getById.call(fake,ID);
 assert.equal(strict.scope,'');assert.equal(legacy.scope,'global');
});

test('strict exact read supports a legacy table without timestamp while the old default remains unchanged',async()=>{
 const row=make();delete row.timestamp;
 const query={select:columns=>{assert.ok(!columns.includes('timestamp'));return query;},where:()=>query,limit:()=>query,toArray:async()=>[row]};
 const fake={supportsTimestamp:false,ensureInitialized:async()=>{},table:{query:()=>query}};
 const strict=await MemoryStore.prototype.getById.call(fake,ID,40,false);
 assert.equal(strict.text,row.text);assert.equal(strict.timestamp,0);
 const legacy=await MemoryStore.prototype.getById.call(fake,ID);
 assert.equal(Number.isNaN(legacy.timestamp),true);
});
