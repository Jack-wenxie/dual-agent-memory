import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { generateSyntheticFixture } from './generate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// This override is only a module source root, never a projection or a home-memory input.
const MQE_ROOT = resolve(process.env.MQE_FIXTURE_SOURCE_ROOT || join(HERE, '../..'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
function textArtifacts(root) {
  const found = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!entry.name.endsWith('.sqlite')) found[relative(root, path).replaceAll('\\', '/')] = hash(readFileSync(path));
    }
  }
  walk(root);
  return found;
}
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'mqe-public-synthetic-'));
  // This path came directly from mkdtemp. Never remove a supplied or source path.
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.match(basename(root), /^mqe-public-synthetic-/u);
    assert.equal(realpathSync(root).toLowerCase(), root.toLowerCase());
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('generator binds its schema and reproduces all text and the logical projection checksum', async (t) => {
  const parent = scratch(t);
  const left = await generateSyntheticFixture({ outDir: join(parent, 'left'), mqeRoot: MQE_ROOT });
  const right = await generateSyntheticFixture({ outDir: join(parent, 'right'), mqeRoot: MQE_ROOT });
  assert.equal(left.pointer.checksum, right.pointer.checksum);
  assert.deepEqual(textArtifacts(join(parent, 'left')), textArtifacts(join(parent, 'right')));
  const { auditProjection } = await import(pathToFileURL(join(MQE_ROOT, 'projection/projection_contract.mjs')).href);
  const audit = auditProjection({ dataDir: join(left.projectRoot, 'data/projection') });
  assert.equal(audit.ok, true);
  assert.equal(audit.counts.records, 3);
  assert.equal(audit.counts.authority_routes, 2);
  assert.deepEqual(audit.violations, []);
  const defaults = JSON.parse(readFileSync(join(left.projectRoot, 'config/engine.defaults.json'), 'utf8'));
  assert.equal(defaults.authority_entry_enabled, false);
  const marker = JSON.parse(readFileSync(join(left.projectRoot, 'PUBLIC_SYNTHETIC_FIXTURE.json'), 'utf8'));
  assert.equal(marker.generated, true);
  assert.equal(marker.seed, 20261010);
});

test('engine recalls and hydrates only the generated records, authority target and entity', async (t) => {
  const fixture = await generateSyntheticFixture({ outDir: join(scratch(t), 'fixture'), mqeRoot: MQE_ROOT });
  const { createMemoryQueryEngine } = await import(pathToFileURL(join(MQE_ROOT, 'src/engine.mjs')).href);
  const engine = createMemoryQueryEngine({ projectRoot: fixture.projectRoot, clock: () => new Date('2026-01-02T00:00:00Z') });
  try {
  const result = engine.query({ queryText: 'demo rule' });
  assert.equal(result.pack.decision, 'retrieve_pack');
  assert.equal(result.pack.cards.length, 1);
  assert.equal(result.pack.cards[0].record_ref, fixture.description.expected_refs['fixture-rule-current']);
  assert.equal(result.pack.cards[0].safe_excerpt, 'Use the blue folder for the current demo.');
  const record = engine.hydrate({ recordRef: result.pack.cards[0].record_ref, corpusEpoch: fixture.pointer.corpus_epoch });
  assert.equal(record.content, 'Use the blue folder for the current demo.');
  const old = engine.query({ queryText: 'green folder demo' });
  assert.equal(old.pack.cards?.some((card) => card.record_ref === fixture.description.expected_refs['fixture-rule-old']) ?? false, false);
  const route = engine.query({ queryText: 'demo project', runtimeContext: { intent: 'status' } });
  assert.equal(route.pack.decision, 'route_authority');
  const authority = engine.hydrate({ recordRef: route.pack.authority_target.record_ref, corpusEpoch: fixture.pointer.corpus_epoch });
  assert.match(authority.content, /Current stage: synthetic offline demonstration\./);
  const entity = engine.query({ queryText: 'dh' });
  assert.equal(entity.pack.decision, 'retrieve_pack');
  assert.equal(entity.pack.cards[0].memory_kind, 'entity');
  const entityResult = engine.hydrate({ recordRef: entity.pack.cards[0].record_ref, corpusEpoch: fixture.pointer.corpus_epoch });
  assert.equal(entityResult.content, 'Demo handbook');
  assert.equal(engine.query({ queryText: 'ok' }).pack.decision, 'abstain');
  } finally {
    // Close the SQLite reader before the temporary directory cleanup hook runs.
    engine.close();
  }
});

test('generator refuses existing, overlapping, missing and unsupported inputs without overwriting', async (t) => {
  const parent = scratch(t);
  const occupied = join(parent, 'occupied');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'keep.txt'), 'keep');
  await assert.rejects(generateSyntheticFixture({ outDir: occupied, mqeRoot: MQE_ROOT }), /fixture_output_exists/);
  assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(generateSyntheticFixture({ outDir: join(MQE_ROOT, 'data', 'bad-fixture'), mqeRoot: MQE_ROOT }), /fixture_output_overlaps_source/);
  await assert.rejects(generateSyntheticFixture({ mqeRoot: MQE_ROOT }), /fixture_out_required/);
  await assert.rejects(generateSyntheticFixture({ outDir: join(parent, 'bad-seed'), mqeRoot: MQE_ROOT, seed: 7 }), /fixture_seed_not_supported/);
  assert.equal(existsSync(join(parent, 'bad-seed')), false);
});

test('generator refuses a linked output parent before creating a fixture', async (t) => {
  const parent = scratch(t);
  const actual = join(parent, 'actual');
  const linked = join(parent, 'linked');
  mkdirSync(actual);
  symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(generateSyntheticFixture({ outDir: join(linked, 'fixture'), mqeRoot: MQE_ROOT }), /fixture_path_link|fixture_path_alias/);
  assert.equal(existsSync(join(actual, 'fixture')), false);
});

test('host-recall profile provides exactly three current mapped synthetic records', async (t) => {
  const parent = scratch(t);
  const generated = await generateSyntheticFixture({ outDir: join(parent, 'host'), mqeRoot: MQE_ROOT, profile: 'host-recall' });
  const db = new DatabaseSync(join(generated.projectRoot, 'data/projection', generated.pointer.filename), { readOnly: true });
  try {
    const rows = db.prepare('SELECT record_id,status,superseded_by FROM records ORDER BY record_id').all();
    assert.deepEqual(rows.map((row) => row.record_id), ['fixture-host-checklist', 'fixture-host-folder', 'fixture-host-notebook']);
    assert.ok(rows.every((row) => row.status === 'active' && row.superseded_by === null));
    assert.equal(db.prepare('SELECT count(*) AS n FROM supersession_edges').get().n, 0);
    assert.equal(generated.description.profile, 'host-recall');
  } finally { db.close(); }
});

test('unknown fixture profiles are refused before creating output', async (t) => {
  const parent = scratch(t), destination = join(parent, 'unknown');
  await assert.rejects(generateSyntheticFixture({ outDir: destination, mqeRoot: MQE_ROOT, profile: 'unknown' }), /fixture_profile_not_supported/u);
  assert.equal(existsSync(destination), false);
});
