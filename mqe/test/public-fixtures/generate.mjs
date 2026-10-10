import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_SEED = 20261010;
const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contentHash = (bytes) => `sha256:${hash(bytes)}`;
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}
function within(parent, child) {
  const tail = relative(parent, child);
  return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail));
}
function assertNoLinks(path) {
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    if (existsSync(cursor)) {
      requireCondition(!lstatSync(cursor).isSymbolicLink(), 'fixture_path_link');
      const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
      requireCondition(normalize(realpathSync(cursor)) === normalize(cursor), 'fixture_path_alias');
    }
    if (dirname(cursor) === cursor) break;
  }
}
function writeNew(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' });
}

export function syntheticConfig(targetHash, entryAuditFingerprint, entryRowId) {
  const aliases = ['demo project', 'sample project'];
  const route = {
    route_id: 'demo-status', project_id: 'demo-project', intent: 'status', aliases,
    root_id: 'workflow_root', relative_path: 'fixtures/project-status.md', section: '# Demo project',
    expected_content_hash: targetHash, resolution: 'resolved', answerability: 'route_authority',
    fresh_until: '2099-01-01T00:00:00.000Z',
  };
  const entry = {
    route_id: route.route_id, project_id: route.project_id, intent: route.intent, aliases,
    root_id: route.root_id, relative_path: route.relative_path, section: route.section,
    entry_label: 'Demo project progress',
    entry_rows: aliases.map((alias) => ({ alias_norm: alias, row_id: entryRowId(route.route_id, alias) })),
    entry_audit: '', entry_audited: true,
  };
  entry.entry_audit = entryAuditFingerprint(entry);
  return {
    'engine.defaults.json': {
      max_query_chars: 512, max_candidates: 12, max_evidence_cards: 3, deadline_ms: 250,
      absolute_floor: 0.58, top1_margin: 0.08, exact_alias_floor: 0.9, exact_entity_floor: 0.9,
      short_query_max_chars: 2, safe_excerpt_max_chars: 240,
      status_terms: ['status', 'progress'], authority_entry_enabled: false,
    },
    'authority_map.v1.json': { schema_version: '1.0.0', routes: [route] },
    'authority_entry_overlay.v1.json': { schema_version: 'authority-entry-overlay/1.0.0', routes: [entry] },
    'entity_aliases.v1.json': {
      schema_version: '1.0.0', aliases: [{
        entity: 'Demo handbook', alias: 'dh', root_id: 'workflow_root',
        relative_path: 'fixtures/handbook.md', source: 'curated_short_alias', score: 1,
      }],
    },
    'source_roots.v1.json': {
      schema_version: 'mqe-source-roots/v1', roots: {
        shared_primary: 'sources/shared_primary', cc_active: 'sources/peer',
        phd_hub: 'sources/notes', workflow_root: '.', codex_home: 'sources/primary-home',
        claude_home: 'sources/peer-home', sport_vault: 'sources/navigation',
      },
    },
  };
}

/** Generates only into a new explicit container, never a source tree or a live data directory. */
export async function generateSyntheticFixture({ outDir, mqeRoot = resolve(HERE, '../..'), seed = FIXTURE_SEED, profile = 'default' } = {}) {
  requireCondition(typeof outDir === 'string' && outDir.length > 0, 'fixture_out_required');
  requireCondition(seed === FIXTURE_SEED, 'fixture_seed_not_supported');
  requireCondition(profile === 'default' || profile === 'host-recall', 'fixture_profile_not_supported');
  const sourceRoot = resolve(mqeRoot);
  const container = resolve(outDir);
  requireCondition(!within(sourceRoot, container) && !within(container, sourceRoot), 'fixture_output_overlaps_source');
  assertNoLinks(sourceRoot);
  assertNoLinks(container);
  requireCondition(!existsSync(container), 'fixture_output_exists');
  requireCondition(existsSync(dirname(container)), 'fixture_parent_missing');
  const schemaPath = join(sourceRoot, 'projection/schema.sql');
  const schema = readFileSync(schemaPath, 'utf8');
  const contract = await import(pathToFileURL(join(sourceRoot, 'projection/projection_contract.mjs')).href);
  const refs = await import(pathToFileURL(join(sourceRoot, 'src/record-ref.mjs')).href);
  const entryApi = await import(pathToFileURL(join(sourceRoot, 'src/authority-entry.mjs')).href);
  const normalize = await import(pathToFileURL(join(sourceRoot, 'src/normalize.mjs')).href);
  mkdirSync(container);
  const workspace = join(container, 'workspace');
  const projectRoot = join(workspace, 'agent-capabilities/mqe');
  const dataDir = join(projectRoot, 'data/projection');
  mkdirSync(dataDir, { recursive: true });
  for (const name of ['shared_primary', 'peer', 'notes', 'primary-home', 'peer-home', 'navigation']) {
    mkdirSync(join(projectRoot, 'sources', name), { recursive: true });
  }
  const statusText = '# Demo project\n\nCurrent stage: synthetic offline demonstration.\n';
  const handbookText = '# Demo handbook\n\nAll examples in this handbook are generated test data.\n';
  writeNew(join(projectRoot, 'fixtures/project-status.md'), statusText);
  writeNew(join(projectRoot, 'fixtures/handbook.md'), handbookText);
  const configs = syntheticConfig(contentHash(statusText), entryApi.entryAuditFingerprint, entryApi.entryRowId);
  requireCondition(entryApi.validateEntryOverlay(configs['authority_entry_overlay.v1.json'], configs['authority_map.v1.json'])?.size === 2, 'fixture_overlay_invalid');
  for (const [name, value] of Object.entries(configs)) writeNew(join(projectRoot, 'config', name), jsonText(value));
  // Public deterministic fixture material, not an operational credential or a key-file interface.
  const fixtureKey = createHash('sha256').update(`public-synthetic-fixture/${seed}`).digest();
  const keyId = refs.refKeyId(fixtureKey);
  const db = new DatabaseSync(':memory:');
  const recordRefs = {};
  let pointer;
  try {
    db.exec(schema);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN;');
    const addRecord = db.prepare(`INSERT INTO records
      (record_id,record_ref,origin,kind,project_id,status,recorded_time,content_hash,answerability,
       safe_excerpt,safe_excerpt_status,source_pointer,search_text,compiled_at,authority_rank,superseded_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const examples = profile === 'host-recall' ? [
      { id: 'fixture-host-notebook', alias: 'sample notebook', text: 'The synthetic sample notebook has a blue cover.', status: 'active', successor: null },
      { id: 'fixture-host-checklist', alias: 'sample checklist', text: 'The synthetic sample checklist contains three steps.', status: 'active', successor: null },
      { id: 'fixture-host-folder', alias: 'sample folder', text: 'The synthetic sample folder holds the paper compass.', status: 'active', successor: null },
    ] : [
      { id: 'fixture-rule-current', alias: 'demo rule', text: 'Use the blue folder for the current demo.', status: 'active', successor: null },
      { id: 'fixture-rule-old', alias: 'green folder demo', text: 'The old demo used a green folder.', status: 'superseded', successor: 'fixture-rule-current' },
      { id: 'fixture-style', alias: 'demo writing style', text: 'Use short sentences in the generated example.', status: 'active', successor: null },
    ];
    for (const item of examples) {
      const ref = refs.makeRecordRef(item.id, fixtureKey);
      recordRefs[item.id] = ref;
      const text = `# ${item.alias}\n\n${item.text}\n`;
      const digest = contentHash(text);
      writeNew(join(projectRoot, 'sources/shared_primary', `${item.id}.md`), text);
      addRecord.run(item.id, ref, 'lancedb', 'rule', 'demo-project', item.status, FIXED_TIME, digest,
        'memory_allowed', item.text, 'accepted', `shared_primary:${item.id}.md`,
        `${item.alias} ${item.text}`, FIXED_TIME, 50, item.successor);
      db.prepare('INSERT INTO record_sources(record_id,root_id,relative_path,source_hash,merge_basis) VALUES(?,?,?,?,?)')
        .run(item.id, 'shared_primary', `${item.id}.md`, digest, 'native_source');
      db.prepare('INSERT INTO aliases(alias_norm,record_id,alias,source,confidence) VALUES(?,?,?,?,?)')
        .run(normalize.normalizeStrict(item.alias), item.id, item.alias, 'memory_index_label', 1);
      db.prepare('INSERT INTO records_fts(record_id,search_text) VALUES(?,?)').run(item.id, `${item.alias} ${item.text}`);
    }
    if (profile === 'default') db.prepare('INSERT INTO supersession_edges(predecessor_id,successor_id) VALUES(?,?)').run('fixture-rule-old', 'fixture-rule-current');
    const route = configs['authority_map.v1.json'].routes[0];
    const authorityRef = refs.makeAuthorityRef([route.root_id, route.relative_path, route.section], fixtureKey);
    for (const alias of route.aliases) {
      const aliasNorm = normalize.normalizeStrict(alias);
      db.prepare(`INSERT INTO authority_routes
        (route_id,alias_norm,project_id,intent,authority_target,target_ref,root_id,relative_path,section,
         content_hash,answerability,resolution,fresh_until,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(entryApi.entryRowId(route.route_id, aliasNorm), aliasNorm, route.project_id, route.intent,
          `authority:${route.root_id}:${route.relative_path}#${route.section}`, authorityRef,
          route.root_id, route.relative_path, route.section, route.expected_content_hash,
          route.answerability, route.resolution, route.fresh_until, 1);
    }
    const entityPointer = 'workflow_root:fixtures/handbook.md';
    const entityRef = refs.makeEntityRef(['Demo handbook', entityPointer], fixtureKey);
    db.prepare(`INSERT INTO entity_routes
      (alias_norm,entity,source_pointer,entity_ref,root_id,relative_path,content_hash,answerability,
       resolution,active,score,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('dh', 'Demo handbook', entityPointer, entityRef, 'workflow_root', 'fixtures/handbook.md',
        contentHash(handbookText), 'pointer_only', 'resolved', 1, 1, 'curated_short_alias');
    const metadata = {
      schema_version: '2.0.0', checksum_contract: contract.PROJECTION_CHECKSUM_CONTRACT,
      ref_key_id: keyId, raw_trace_included: '0', built_at: FIXED_TIME, mode: 'synthetic_fixture',
    };
    for (const [key, value] of Object.entries(metadata)) db.prepare('INSERT INTO projection_meta(key,value) VALUES(?,?)').run(key, value);
    const checksum = contract.logicalProjectionChecksum(db, { refKeyId: keyId, schemaPath });
    const epoch = checksum.slice(7, 23);
    db.prepare('INSERT INTO projection_meta(key,value) VALUES(?,?)').run('checksum', checksum);
    db.prepare('INSERT INTO projection_meta(key,value) VALUES(?,?)').run('corpus_epoch', epoch);
    db.exec('COMMIT;');
    pointer = { schema_version: '2.0.0', ref_key_id: keyId, corpus_epoch: epoch,
      filename: `memory_index.${epoch}.sqlite`, checksum, updated_at: FIXED_TIME };
    const binding = contract.projectionBindingReport(db, { pointer });
    requireCondition(binding.ok, 'fixture_binding_invalid');
    await backup(db, join(dataDir, pointer.filename));
  } finally {
    db.close();
  }
  writeNew(join(dataDir, 'CURRENT.json'), jsonText(pointer));
  writeNew(join(projectRoot, 'PUBLIC_SYNTHETIC_FIXTURE.json'), jsonText({
    schema: 'mqe-public-synthetic-fixture/v1', seed, generated: true,
    generated_by: 'mqe/test/public-fixtures/generate.mjs', schema_version: '2.0.0',
  }));
  writeNew(join(projectRoot, 'testdata/replay.queries.jsonl'), (profile === 'host-recall' ? [
    { id: 'host-001', query_text: 'sample notebook', expect: 'retrieve_pack' },
    { id: 'host-002', query_text: 'sample checklist', expect: 'retrieve_pack' },
    { id: 'host-003', query_text: 'sample folder', expect: 'retrieve_pack' },
    { id: 'host-004', query_text: 'dh', expect: 'retrieve_pack' },
  ] : [
    { id: 'demo-001', query_text: 'demo rule', expect: 'retrieve_pack' },
    { id: 'demo-002', query_text: 'demo writing style', expect: 'retrieve_pack' },
    { id: 'demo-003', query_text: 'dh', expect: 'retrieve_pack' },
    { id: 'demo-004', query_text: 'demo project' },
  ]).map((row) => JSON.stringify(row)).join('\n') + '\n');
  const audit = contract.auditProjection({ dataDir });
  requireCondition(audit.ok, 'fixture_projection_audit_failed');
  const description = { schema: 'mqe-public-synthetic-generation/v1', seed, synthetic_only: true,
    ...(profile === 'default' ? {} : { profile }),
    project_root: 'workspace/agent-capabilities/mqe', schema_sha256: hash(Buffer.from(schema)),
    logical_checksum: pointer.checksum, corpus_epoch: pointer.corpus_epoch,
    records: 3, authority_routes: 2, entities: 1, authority_entry_enabled: false,
    expected_refs: recordRefs };
  writeNew(join(container, 'GENERATION.json'), jsonText(description));
  return { projectRoot, workspace, pointer, description };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const allowed = new Set(['--out', '--mqe-root', '--profile']);
    const values = {};
    requireCondition(args.length > 0 && args.length % 2 === 0, 'fixture_arguments_invalid');
    for (let index = 0; index < args.length; index += 2) {
      requireCondition(allowed.has(args[index]) && !Object.hasOwn(values, args[index]) && Boolean(args[index + 1]), 'fixture_arguments_invalid');
      values[args[index]] = args[index + 1];
    }
    const result = await generateSyntheticFixture({ outDir: values['--out'], mqeRoot: values['--mqe-root'], profile: values['--profile'] });
    console.log(JSON.stringify(result.description));
  } catch {
    console.error('synthetic_fixture_generation_failed');
    process.exitCode = 1;
  }
}
