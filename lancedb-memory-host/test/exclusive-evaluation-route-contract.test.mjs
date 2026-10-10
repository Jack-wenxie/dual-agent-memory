import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');

test('exclusive initialization always releases its synchronous reservation', () => {
  const reserve = source.indexOf('leaseReservation = exclusiveEvaluationInitializationGate.reserve(leaseId)');
  const readiness = source.indexOf('const ready = await exclusiveEvaluationAdmissionReady()', reserve);
  const claim = source.indexOf('leaseOwner = exclusiveEvaluationLease.claim(', readiness);
  const releaseFinally = source.indexOf(
    'finally {\n    if (maintenanceReservation) c08MaintenanceBarrier.cancel(maintenanceReservation);\n    releaseInitializationReservation();\n  }',
    claim,
  );
  const createServer = source.indexOf(': createServer(leaseOwner);', releaseFinally);

  assert.ok(reserve >= 0, 'initialize must reserve before asynchronous admission');
  assert.ok(readiness > reserve);
  assert.ok(claim > readiness);
  assert.ok(releaseFinally > claim, 'reservation must be released by a finally block');
  assert.ok(createServer > releaseFinally, 'transport setup must begin only after reservation release');
  assert.equal(
    (source.match(/releaseInitializationReservation\(\);/gu) || []).length,
    1,
    'manual branch releases can regress exception safety',
  );
});

test('transport setup failures release the exact owner and cannot delete a replacement session', () => {
  const setupTry = source.indexOf('try {\n    server = maintenancePurpose !== null && leaseOwner');
  const constructor = source.indexOf('transport = new StreamableHTTPServerTransport({', setupTry);
  const connect = source.indexOf('await server.connect(transport)', constructor);
  const setupCatch = source.indexOf('} catch {\n    releaseTransport();', connect);
  const safeClose = source.indexOf('try { await transport?.close(); } catch {}', setupCatch);
  const identityGuard = source.indexOf(
    'if (entry?.transport === activeTransport && entry.leaseOwner === leaseOwner) sessions.delete(id);',
  );

  assert.ok(setupTry >= 0, 'server creation must be inside the release-protected try');
  assert.ok(constructor > setupTry);
  assert.ok(connect > constructor);
  assert.ok(setupCatch > connect, 'connect/constructor failures must reach releaseTransport');
  assert.ok(safeClose > setupCatch);
  assert.ok(identityGuard >= 0, 'session deletion must verify transport and owner generation identity');
  assert.doesNotMatch(source, /if \(id\) sessions\.delete\(id\);/u);
});
test('successful DELETE explicitly retires the exact lease session after SDK handling', () => {
  const handlerStart = source.indexOf('async function handleSessionRequest(');
  const handlerEnd = source.indexOf('\n}\n\napp.post', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'session request handler must exist');
  const handler = source.slice(handlerStart, handlerEnd);
  const handled = handler.indexOf('await entry.transport.handleRequest(req, res);');
  const retired = handler.indexOf('if (req.method === "DELETE") retireSession(id, entry);', handled);
  assert.ok(handled >= 0, 'SDK transport request must be handled');
  assert.ok(retired > handled, 'successful DELETE must retire the exact session after SDK handling');
});

test('DELETE retirement is identity-guarded and releases the exact owner generation', () => {
  const retireStart = source.indexOf('function retireSession(id: string, entry: MemorySession): void {');
  const retireEnd = source.indexOf('}', retireStart);
  assert.ok(retireStart >= 0 && retireEnd > retireStart, 'retireSession must exist');
  const retireBody = source.slice(retireStart, retireEnd);
  assert.ok(retireBody.includes('if (sessions.get(id) === entry) sessions.delete(id);'));
  assert.ok(retireBody.includes('exclusiveEvaluationLease.release(entry.leaseOwner);'));

  const handlerStart = source.indexOf('async function handleSessionRequest(');
  const handlerEnd = source.indexOf('app.post', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const deleteRetire = 'if (req.method === "DELETE") retireSession(id, entry);';
  assert.equal(
    handler.split(deleteRetire).length - 1,
    1,
    'successful DELETE must invoke the exact-session retirement seam once',
  );
});
