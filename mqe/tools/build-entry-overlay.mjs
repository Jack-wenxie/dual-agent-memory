#!/usr/bin/env node
// Builds a candidate authority entry overlay from human-reviewed labels and the current projection.
// Read-only on project state. It writes only the explicit --out file, refuses to overwrite, and never
// touches config/. A person reviews the output and installs it separately.
//
// Usage: node tools/build-entry-overlay.mjs --project-root <MQE root> --labels <labels.json> --out <file>
// labels.json maps route_id to a reviewed label, for example {"example-status": "Example project status"}.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ENTRY_OVERLAY_SCHEMA,
  entryAuditFingerprint,
  entryRowId,
  validateEntryOverlay,
} from '../src/authority-entry.mjs';
import { resolveProjection } from '../src/db.mjs';

export function buildEntryOverlay({ projectRoot, labels }) {
  const map = JSON.parse(readFileSync(join(projectRoot, 'config', 'authority_map.v1.json'), 'utf8'));
  const { dbPath } = resolveProjection(projectRoot);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const routes = [];
  const problems = [];
  try {
    const select = db.prepare('SELECT * FROM authority_routes WHERE substr(route_id,1,?)=? AND active=1 ORDER BY route_id');
    for (const [routeId, label] of Object.entries(labels ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const route = (map.routes ?? []).find((item) => item.route_id === routeId);
      if (!route) { problems.push({ route_id: routeId, problem: 'not_in_authority_map' }); continue; }
      if (route.resolution !== 'resolved') { problems.push({ route_id: routeId, problem: 'not_configured_resolved' }); continue; }
      const relative = String(route.relative_path ?? '').replaceAll('\\', '/');
      const prefix = `${routeId}:`;
      const entryRows = [];
      for (const row of select.all(prefix.length, prefix)) {
        const tupleMatches = row.project_id === route.project_id && row.intent === (route.intent ?? 'status')
          && row.root_id === route.root_id && row.relative_path === relative && row.section === route.section;
        if (row.route_id !== entryRowId(routeId, row.alias_norm) || !tupleMatches) {
          problems.push({ route_id: routeId, problem: 'projection_row_mismatch', row_id: row.route_id });
          continue;
        }
        entryRows.push({ alias_norm: row.alias_norm, row_id: row.route_id });
      }
      if (!entryRows.length) { problems.push({ route_id: routeId, problem: 'no_projection_rows' }); continue; }
      const entry = {
        route_id: routeId, project_id: route.project_id, intent: route.intent ?? 'status', aliases: [...route.aliases],
        root_id: route.root_id, relative_path: relative, section: route.section, entry_label: label,
        entry_rows: entryRows, entry_audit: '', entry_audited: true,
      };
      entry.entry_audit = entryAuditFingerprint(entry);
      routes.push(entry);
    }
  } finally {
    db.close();
  }
  const overlay = { schema_version: ENTRY_OVERLAY_SCHEMA, routes };
  const admitted = problems.length === 0 && validateEntryOverlay(overlay, map) !== null;
  return { overlay, problems, admitted };
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function main(argv) {
  const projectRoot = argument(argv, '--project-root');
  const labelsPath = argument(argv, '--labels');
  const outPath = argument(argv, '--out');
  if (!projectRoot || !labelsPath || !outPath) {
    process.stderr.write('usage: build-entry-overlay --project-root <dir> --labels <labels.json> --out <file>\n');
    return 2;
  }
  const { overlay, problems, admitted } = buildEntryOverlay({
    projectRoot: resolve(projectRoot), labels: JSON.parse(readFileSync(labelsPath, 'utf8')),
  });
  process.stdout.write(`${JSON.stringify({ admitted, routes: overlay.routes.length,
    rows: overlay.routes.reduce((sum, entry) => sum + entry.entry_rows.length, 0), problems })}\n`);
  if (!admitted) return 1;
  if (existsSync(outPath)) {
    process.stderr.write('refusing to overwrite an existing file\n');
    return 1;
  }
  writeFileSync(outPath, `${JSON.stringify(overlay, null, 1)}\n`, { encoding: 'utf8', flag: 'wx' });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
