
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {MemoryCoordinator} from '../src/memory-runtime.ts';
import {createWritePlaneAdapter} from '../src/write-plane-adapter.ts';
import {MEMORY_EVENT_CONSUMERS} from '../src/consumer-queue.ts';
import {parseEmbeddedWritePlane} from '../src/write-plane.ts';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const hash=x=>createHash('sha256').update(x).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const row=n=>({id:id(n),text:'synthetic public row '+n,vector:[1,0],category:'fact',scope:'global',importance:.7,timestamp:1,metadata:'{}'});
function metadata(memory,mutationId,extra={}){
 const snapshot={category:memory.category,scope:memory.scope,importance:memory.importance,text_sha256:hash(memory.text)};
 const event={schema:'memory-mutation-event/v2',event_id:id(91),mutation_id:mutationId,sequence:1,operation:'update',effect:'updated',memory_id:memory.id,occurred_at:'2026-10-07T00:00:00Z',request_digest:'a'.repeat(64),companion:'no_op',before:snapshot,after:snapshot};
 return JSON.stringify({...extra,_memory_write_plane:{schema:'memory-write-plane-commit/v2',idempotency_hash:'b'.repeat(64),request_digest:event.request_digest,event,delivery:{status:'pending',consumers:[...MEMORY_EVENT_CONSUMERS]}}});
}
function fixture(initial){
 const rows=new Map(initial.map(e=>[e.id,{...e}])),state={onUpdate:null};
 const store={list:async()=>[...rows.values()],getById:async id=>{const e=rows.get(id);return e?{...e}:null;},vectorSearch:async()=>[],bm25Search:async()=>[],
 store:async e=>{rows.set(e.id,{...e,timestamp:1});return rows.get(e.id);},
 update:async(id,u)=>{if(state.onUpdate)return state.onUpdate(id,u);const e=rows.get(id);if(!e)return null;const changed={...e,...u};rows.set(id,changed);return {...changed};},delete:async id=>rows.delete(id)};
 const c=new MemoryCoordinator(store,async()=>[1,0],{bm25DeadlineMs:250,nativeAdmissionDeadlineMs:250});
 return {rows,state,store,c,adapter:createWritePlaneAdapter(store,c)};
}
test('queued old outbox ack cannot overwrite a newer committed global event',async()=>{
 const initial=row(1),oldMutation=id(90),newMutation=id(92);initial.metadata=metadata(initial,oldMutation);
 const f=fixture([initial]);await f.c.initialize();assert.equal((await f.adapter.listPendingOutbox()).length,1);
 const entered=deferred(),commit=deferred();let updates=0;
 f.state.onUpdate=async(id,u)=>{updates++;if(updates===1){entered.resolve();await commit.promise;}const next={...f.rows.get(id),...u};f.rows.set(id,next);return {...next};};
 const newMetadata=metadata(initial,newMutation,{new_public_fact:'preserve'});
 const write=f.c.update(initial.id,{metadata:newMetadata});await entered.promise;
 const oldAck=f.adapter.markOutboxDelivered(initial.id,oldMutation,'2026-10-07T00:00:01Z').then(value=>({status:'resolved',value}),error=>({status:'rejected',error}));
 await Promise.resolve();await Promise.resolve();commit.resolve();await write;const refused=await oldAck;
 assert.equal(parseEmbeddedWritePlane(f.rows.get(initial.id).metadata).event.mutation_id,newMutation,'new committed event must survive the queued old acknowledgement');
 assert.equal(refused.status,'rejected');assert.match(refused.error.message,/Cannot mark unrelated event delivered/);
 assert.equal(f.rows.get(initial.id).metadata,newMetadata);assert.equal(updates,1);assert.equal((await f.adapter.listPendingOutbox()).length,1);
 const valid=await f.adapter.markOutboxDelivered(initial.id,newMutation,'2026-10-07T00:00:02Z');
 assert.equal(parseEmbeddedWritePlane(valid.metadata).delivery.status,'delivered');
 assert.equal(JSON.parse(valid.metadata).new_public_fact,'preserve');assert.equal((await f.adapter.listPendingOutbox()).length,0);
});
test('tombstone acknowledgement enters the mutation fence and never republishes deleted content',async()=>{
 const global=row(1),tomb={...row(2),scope:'__memory_deleted__',text:'synthetic tombstone'},mutation=id(90);tomb.metadata=metadata(tomb,mutation);
 const f=fixture([global,tomb]);await f.c.initialize();const receipt=await f.c.readVisiblePrimary(global.id,global.text);assert.ok(receipt);
 const entered=deferred(),commit=deferred();f.state.onUpdate=async(id,u)=>{entered.resolve();await commit.promise;const next={...f.rows.get(id),...u};f.rows.set(id,next);return {...next};};
 const ack=f.adapter.markOutboxDelivered(tomb.id,mutation,'2026-10-07T00:00:01Z');await entered.promise;
 assert.equal(f.c.visiblePrimaryIsCurrent(receipt),false);assert.equal(f.c.beginPublicReadFence(),null);
 assert.equal(await f.c.readVisiblePrimary(global.id,global.text),null);
 commit.resolve();await ack;assert.equal(f.c.visiblePrimaryIsCurrent(receipt),false);
 assert.equal(f.rows.get(tomb.id).scope,'__memory_deleted__');assert.equal((await f.c.recall('synthetic tombstone',20)).results.some(x=>x.entry.id===tomb.id),false);
});
test('missing row and unrelated current event refuse without a metadata update',async()=>{
 const global=row(1);global.metadata=metadata(global,id(90));const f=fixture([global]);await f.c.initialize();let writes=0;f.state.onUpdate=async()=>{writes++;throw Error('unexpected write');};
 await assert.rejects(()=>f.adapter.markOutboxDelivered(id(99),id(90),'2026-10-07T00:00:01Z'),/durable metadata update failed/);
 await assert.rejects(()=>f.adapter.markOutboxDelivered(global.id,id(92),'2026-10-07T00:00:01Z'),/Cannot mark unrelated event delivered/);
 assert.equal(writes,0);assert.equal(parseEmbeddedWritePlane(f.rows.get(global.id).metadata).delivery.status,'pending');
});
