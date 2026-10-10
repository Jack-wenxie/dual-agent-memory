// Source-only candidate: observations only, no I/O and no changed returned results.
// Raw values are each survivor's genuine proof, never aggregate branch extrema.
const PROFILE=Object.freeze({vector_only_native_ge:1.021803,bm25_only_native_le:6.651042});
const SCHEMA='o001-weak-single-lane-observer/v1';
const hold=reason=>Object.freeze({schema:SCHEMA,status:'HOLD',reason,enforcement_allowed:false});
// Pure numeric classifier for a frozen offline oracle. It grants no proof/permission
// and must not be used to publish results; observe() separately authenticates the input.
export function classifyWeakSingleLane(result,row){
 const sources=[...new Set(result.sources)].sort();
 const evidenceSources=[...new Set(row.contributions.map(c=>c.source))].sort();
 if(sources.join(',')!==evidenceSources.join(',')||row.contributions.length!==sources.length)return 'HOLD_SOURCE';
 if(sources.length===2&&sources[0]==='bm25'&&sources[1]==='vector')return 'KEEP_BOTH';
 if(sources.length!==1||!['vector','bm25'].includes(sources[0]))return 'HOLD_SOURCE';
 const source=sources[0],native=row.contributions[0].native;
 const known=native?.source===source&&native.raw_status==='KNOWN'&&typeof native.raw_value==='number'&&Number.isFinite(native.raw_value)
  &&['native_number','native_bigint_exact'].includes(native.raw_reason);
 if(!known)return 'KEEP_UNKNOWN';
 return source==='vector'?(native.raw_value>=PROFILE.vector_only_native_ge?'DROP_VECTOR':'KEEP_SINGLE'):(native.raw_value<=PROFILE.bm25_only_native_le?'DROP_BM25':'KEEP_SINGLE');
}

export function createWeakSingleLaneObserver(coordinator,{enabled=false}={}){
 const issued=new WeakMap();
 return Object.freeze({
  observe(outcome,lifecycle,{action='observe'}={}){
   if(enabled!==true)return hold('disabled');
   if(action!=='observe')return hold('enforcement_not_implemented');
   try{
    const proof=coordinator.privateScoreEvidence(outcome);
    if(!proof||proof.schema_version!=='private-score-evidence/v1'||!Array.isArray(outcome.results)||!Array.isArray(proof.rows)||proof.rows.length!==outcome.results.length)return hold('genuine_proof_unavailable');
    if(proof.measurement!=='original_execution'||proof.delivery!=='miss')return hold('not_fresh_native_execution');
    if(outcome.branches?.vector!=='ok'||outcome.branches?.bm25!=='ok'||outcome.mode!=='pro-hybrid-rrf')return hold('degraded_not_calibrated');
    if(!lifecycle||!Array.isArray(lifecycle.results)||lifecycle.isCurrent()!==true)return hold('lifecycle_changed');
    const indices=lifecycle.results.map(r=>outcome.results.indexOf(r));
    if(indices.some(i=>i<0)||new Set(indices).size!==indices.length)return hold('lifecycle_not_original_subset');
    const keep=[];let vectorDrop=0,bm25Drop=0,unknownSingle=0,bothKept=0;
    for(const index of indices){
     const result=outcome.results[index],row=proof.rows[index];
     if(row.final_rank!==index+1||!Array.isArray(row.contributions)||!Array.isArray(result.sources))return hold('proof_row_shape');
     const decision=classifyWeakSingleLane(result,row);
     if(decision==='HOLD_SOURCE')return hold('source_proof_mismatch');
     if(decision==='DROP_VECTOR')vectorDrop++;
     else if(decision==='DROP_BM25')bm25Drop++;
     else{
      if(decision==='KEEP_BOTH')bothKept++;
      if(decision==='KEEP_UNKNOWN')unknownSingle++;
      keep.push(index);
     }
    }
    if(lifecycle.isCurrent()!==true)return hold('lifecycle_changed');
    const observation=Object.freeze({schema:SCHEMA,status:'OBSERVATION_ONLY',enforcement_allowed:false,
     measurement:'per_lifecycle_survivor_own_raw_value',lifecycle_selected_count:indices.length,
     would_drop_count:vectorDrop+bm25Drop,vector_only_would_drop:vectorDrop,bm25_only_would_drop:bm25Drop,
     unknown_single_kept:unknownSingle,both_sources_kept:bothKept,shadow_remaining_count:keep.length,
     actual_metric:proof.actual_metric,embedding_model:proof.embedding_model});
    issued.set(observation,Object.freeze([...keep]));return observation;
   }catch{return hold('observation_unavailable');}
  },
  // Offline/host-private diagnostic getter. Not a tool field and never used to publish results.
  privateShadowIndices(observation){
   const indices=observation&&issued.get(observation);
   return indices?Object.freeze([...indices]):null;
  },
 });
}
