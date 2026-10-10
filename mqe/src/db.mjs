import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function resolveProjection(projectRoot) {
  const pointerPath = join(resolve(projectRoot), 'data', 'projection', 'CURRENT.json');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  if (pointer.schema_version !== '2.0.0'
    || !/^rk1_[a-f0-9]{32}$/u.test(pointer.ref_key_id)
    || !/^[a-f0-9]{16}$/u.test(pointer.corpus_epoch)
    || pointer.filename !== `memory_index.${pointer.corpus_epoch}.sqlite`
    || !/^sha256:[a-f0-9]{64}$/u.test(pointer.checksum)
    || pointer.checksum.slice(7, 23) !== pointer.corpus_epoch) {
    throw new Error('invalid_projection_pointer');
  }
  return {
    pointer,
    dbPath: join(dirname(pointerPath), pointer.filename),
  };
}

export function openReadOnlyDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: 5,
  });
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5;');
  return db;
}
