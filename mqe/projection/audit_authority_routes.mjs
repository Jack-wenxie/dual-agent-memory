import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditAuthorityRoutes } from './projection_contract.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.MQE_DATA_DIR ? resolve(process.env.MQE_DATA_DIR) : join(project, 'data', 'projection');

try {
  const report = auditAuthorityRoutes({ dataDir, projectRoot: project });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error_code: 'authority_route_audit_failed',
    error_type: error instanceof Error ? error.name : 'Error',
  }, null, 2)}\n`);
  process.exitCode = 1;
}
