import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {MemoryCoordinator} from '../src/memory-runtime.ts';
import {createWritePlaneAdapter} from '../src/write-plane-adapter.ts';
import {MEMORY_EVENT_CONSUMERS} from '../src/consumer-queue.ts';
import {DELETED_MEMORY_SCOPE, parseEmbeddedWritePlane} from '../src/write-plane.ts';

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = row => row ? {...row, vector: [...row.vector]} : null;

async function fixture() {
  const live = {id:id(1), text:'synthetic livecontrolword', vector:[1,0], category:'fact', scope:'global', importance:.7, timestamp:1, metadata:'{}'};
  const tomb = {...live, id:id(2), text:'synthetic uniquetombword', scope:DELETED_MEMORY_SCOPE};
  const mutationId = id(90);
  const snapshot = {category:tomb.category, scope:'global', importance:tomb.importance, text_sha256:hash(tomb.text)};
  const event = {schema:'memory-mutation-event/v2', event_id:id(91), mutation_id:mutationId, sequence:1, operation:'forget', effect:'tombstoned', memory_id:tomb.id, occurred_at:'2026-10-07T00:00:00Z', request_digest:'a'.repeat(64), companion:'no_op', before:snapshot, after:null};
  tomb.metadata = JSON.stringify({_memory_write_plane:{schema:'memory-write-plane-commit/v2', idempotency_hash:'b'.repeat(64), request_digest:event.request_digest, event, delivery:{status:'pending', consumers:[...MEMORY_EVENT_CONSUMERS]}}});
  const rows = new Map([live,tomb].map(row => [row.id,clone(row)]));
  const store = {
    // Same list visibility as MemoryStore.list(..., includeDeleted=false).
    list:async (_scope,_category,limit=20,offset=0,includeDeleted=false) => [...rows.values()].filter(row=>includeDeleted || row.scope!==DELETED_MEMORY_SCOPE).slice(offset,offset+limit).map(clone),
    getById:async key=>clone(rows.get(key)),
    update:async (key,updates)=>{const old=rows.get(key);if(!old)return null;const next={...old,...updates};rows.set(key,clone(next));return clone(next);},
    vectorSearch:async()=>[], bm25Search:async()=>[],
  };
  const coordinator = new MemoryCoordinator(store, async()=>[1,0]);
  await coordinator.initialize();
  // Inspect the real ExactMemoryIndex instance. Recall would mask an index leak
  // with its downstream scope gate, so it cannot be the oracle for this test.
  const index = coordinator.index;
  assert.ok(index && typeof index.resolveId==='function' && typeof index.search==='function');
  const adapter = createWritePlaneAdapter(store,coordinator);
  return {live,tomb,rows,mutationId,coordinator,index,adapter};
}

test('tombstone ack keeps exact resolution and dedup index invisible', async()=>{
  const {live,tomb,rows,mutationId,index,adapter} = await fixture();
  assert.equal(index.resolveId(live.id)?.id,live.id,'live control is indexed');
  assert.equal(index.resolveId(tomb.id),null,'tombstone starts outside visible index');
  const ack = await adapter.markOutboxDelivered(tomb.id,mutationId,'2026-10-07T00:00:01Z');
  assert.equal(parseEmbeddedWritePlane(ack.metadata).delivery.status,'delivered');
  assert.equal(rows.get(tomb.id).scope,DELETED_MEMORY_SCOPE,'durable tombstone must remain a tombstone');
  assert.equal(index.resolveId(tomb.id),null,'ack must not publish a tombstone into ID resolution');
  assert.equal(index.duplicate(tomb.text),null,'ack must not publish a tombstone into dedup');
  assert.equal(index.resolveId(live.id)?.id,live.id,'unrelated live control survives');
});

test('tombstone ack keeps the local lexical index invisible before scope gates', async()=>{
  const {live,tomb,mutationId,index,adapter} = await fixture();
  assert.deepEqual(index.search('uniquetombword',20),[],'tombstone begins unsearchable');
  assert.deepEqual(index.search('livecontrolword',20).map(hit=>hit.entry.id),[live.id],'real lexical matcher finds the live control');
  const ack = await adapter.markOutboxDelivered(tomb.id,mutationId,'2026-10-07T00:00:01Z');
  assert.equal(parseEmbeddedWritePlane(ack.metadata).delivery.status,'delivered');
  assert.deepEqual(index.search('uniquetombword',20),[],'ack must not publish a tombstone into lexical search');
  assert.equal(index.search('synthetic',20).some(hit=>hit.entry.id===tomb.id),false,'mixed query must still omit deleted content');
  assert.deepEqual(index.search('livecontrolword',20).map(hit=>hit.entry.id),[live.id]);
});
