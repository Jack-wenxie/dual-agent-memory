import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultAuthorityRoots } from '../projection/projection_contract.mjs';

const keys = ['shared_primary', 'cc_active', 'phd_hub', 'workflow_root', 'codex_home', 'claude_home', 'sport_vault'];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mqe-source-root-test-'));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.match(basename(root), /^mqe-source-root-test-/u);
    assert.equal(realpathSync(root).toLowerCase(), root.toLowerCase());
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'config'));
  return root;
}
function config(root, roots) {
  writeFileSync(join(root, 'config/source_roots.v1.json'), JSON.stringify({ schema_version: 'mqe-source-roots/v1', roots }));
}
test('root discovery requires explicit config and never falls back to home', (t) => {
  const root = fixture(t);
  assert.throws(() => defaultAuthorityRoots({ projectRoot: root, environment: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root } }));
});
test('synthetic relative roots resolve against project only', (t) => {
  const root = fixture(t);
  config(root, Object.fromEntries(keys.map((key) => [key, key === 'workflow_root' ? '.' : `sources/${key}`])));
  const result = defaultAuthorityRoots({ projectRoot: root, environment: {} });
  assert.equal(result.workflow_root, root);
  assert.equal(result.shared_primary, join(root, 'sources/shared_primary'));
  assert.deepEqual(Object.keys(result), keys);
});
test('missing, unknown or invalid root entry refuses whole config', (t) => {
  const root = fixture(t);
  const valid = Object.fromEntries(keys.map((key) => [key, '.']));
  for (const roots of [{ ...valid, unknown: '.' }, { ...valid, shared_primary: '' }, { ...valid, shared_primary: false }]) {
    config(root, roots);
    assert.throws(() => defaultAuthorityRoots({ projectRoot: root, environment: {} }));
  }
  delete valid.shared_primary;
  config(root, valid);
  assert.throws(() => defaultAuthorityRoots({ projectRoot: root, environment: {} }));
});
