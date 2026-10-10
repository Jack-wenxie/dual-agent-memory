import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basename, resolve } from 'node:path';

const [leftPath, rightPath] = process.argv.slice(2).map((value) => resolve(value));
if (!leftPath || !rightPath) throw new Error('usage: node compare_projection_epochs.mjs <left.sqlite> <right.sqlite>');

const tables = [
  ['records', 'record_id'],
  ['aliases', 'alias_norm,record_id,alias'],
  ['short_grams', 'gram,record_id,source'],
  ['record_sources', 'record_id,root_id,relative_path'],
  ['authority_routes', 'route_id'],
  ['entity_routes', 'alias_norm,entity,source_pointer'],
  ['supersession_edges', 'predecessor_id,successor_id'],
  ['records_fts', 'record_id,search_text'],
];

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function keyFor(row, fields) {
  return fields.map((field) => String(row[field] ?? '')).join('\0');
}

function readTable(path, table, keySpec) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    const fields = keySpec.split(',');
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    return new Map(rows.map((row) => [keyFor(row, fields), row]));
  } finally {
    db.close();
  }
}

const report = {
  schema_version: '1.0.0',
  left: basename(leftPath),
  right: basename(rightPath),
  tables: {},
};

for (const [table, keySpec] of tables) {
  const left = readTable(leftPath, table, keySpec);
  const right = readTable(rightPath, table, keySpec);
  const keys = new Set([...left.keys(), ...right.keys()]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of keys) {
    const a = left.get(key);
    const b = right.get(key);
    if (!a) added.push(digest(key));
    else if (!b) removed.push(digest(key));
    else {
      const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
      if (fields.length) changed.push({
        key_hash: digest(key),
        ...(process.env.MQE_COMPARE_SHOW_KEYS === '1' ? { key } : {}),
        fields,
      });
    }
  }
  report.tables[table] = {
    left: left.size, right: right.size,
    added_count: added.length, removed_count: removed.length, changed_count: changed.length,
    added_key_hashes: added.slice(0, 20), removed_key_hashes: removed.slice(0, 20), changed: changed.slice(0, 20),
  };
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
