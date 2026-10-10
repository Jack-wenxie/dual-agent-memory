import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const host = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const barrier = readFileSync(
  new URL("../src/c08-contract-cas-maintenance.ts", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

test("Maintenance identity is an exact dedicated header and purpose", () => {
  assert.match(barrier, /C08_MAINTENANCE_HEADER = "x-memory-maintenance-purpose"/u);
  assert.match(barrier, /C08_MAINTENANCE_PURPOSE = "c08-contract-cas"/u);
  assert.match(host, /req\.headers\[C08_MAINTENANCE_HEADER\]/u);
  assert.match(host, /value !== C08_MAINTENANCE_PURPOSE/u);
});

test("maintenance acquisition closes producer admission before its first await", () => {
  const routeStart = host.indexOf('app.post("/mcp/:token"');
  const newSessionStart = host.indexOf("const leaseId = leaseHeader.id;", routeStart);
  const setupStart = host.indexOf("let server: McpServer | null = null;", newSessionStart);
  assert.ok(routeStart >= 0 && newSessionStart > routeStart && setupStart > newSessionStart);
  const admission = host.slice(newSessionStart, setupStart);
  const reserve = admission.indexOf("maintenanceReservation = c08MaintenanceBarrier.reserve(leaseId)");
  const staleCloseAwait = admission.indexOf("try { await staleEntry.transport.close(); } catch {}");
  const prepareAwait = admission.indexOf("const quiescence = await prepareC08MaintenanceAcquisition()");
  assert.ok(reserve >= 0, "maintenance barrier must synchronously enter acquiring");
  assert.ok(staleCloseAwait > reserve, "stale-session retirement may not precede maintenance reservation");
  assert.ok(prepareAwait > reserve, "fixed-point acquisition may not precede maintenance reservation");
  assert.match(admission, /finally \{\n    if \(maintenanceReservation\) c08MaintenanceBarrier\.cancel\(maintenanceReservation\);\n    releaseInitializationReservation\(\);\n  \}/u);
});

test("acquiring and held barriers stop all ordinary host producers", () => {
  assert.match(
    host,
    /if \(!c08MaintenanceBarrier\.blocksProducers\) \{\n      candidateRecovery = await candidateWritePlane\.recover\(\);\n      await runCompanionDrain\(candidateStore\);\n    \}/u,
  );
  assert.match(host, /async function runCompanionDrain\(store: MemoryStore\): Promise<void> \{\n  if \(c08MaintenanceBarrier\.blocksProducers\) return;/u);
  assert.match(
    host,
    /if \(c08MaintenanceBarrier\.blocksProducers\n          \|\| exclusiveEvaluationInitializationGate\.active\n          \|\| exclusiveEvaluationLease\.snapshot\(null\)\.active\n          \|\| periodicWritePlaneRecovery\.active\) return;/u,
  );
  assert.match(host, /if \(c08MaintenanceBarrier\.blocksProducers\) return null;/u);
  assert.match(host, /capability === controlledMaintenanceRecoveryCapability/u);
  assert.doesNotMatch(host, /export (?:const|let|var) controlledMaintenanceRecoveryCapability/u);
});

test("maintenance MCP surface is read-only and limited to ping plus status", () => {
  const start = host.indexOf("function createC08MaintenanceServer(");
  const end = host.indexOf("\n}\n\n//", start);
  assert.ok(start >= 0 && end > start);
  const server = host.slice(start, end);
  assert.deepEqual(
    [...server.matchAll(/maintenanceServer\.tool\("([^"]+)"/gu)].map((match) => match[1]),
    ["ping", "status"],
  );
  assert.doesNotMatch(server, /memory_(?:store|save_tx|update|forget|recall|list|stats)/u);
  assert.match(host, /\? createC08MaintenanceServer\(leaseOwner, leaseId!\)\n      : createServer\(leaseOwner\);/u);
});

test("close, transport error, request error, and TTL loss orphan without removing the fence", () => {
  const retireStart = host.indexOf("function retireSession(id: string, entry: MemorySession): void {");
  const retireEnd = host.indexOf("\n}", retireStart);
  const retire = host.slice(retireStart, retireEnd);
  assert.match(retire, /c08MaintenanceBarrier\.orphan\(entry\.maintenanceOwner\);/u);
  assert.match(retire, /exclusiveEvaluationLease\.release\(entry\.leaseOwner\);/u);
  assert.doesNotMatch(retire, /c08MaintenanceBarrier\.release/u);

  const releaseTransportStart = host.indexOf("const releaseTransport = () => {");
  const setupTry = host.indexOf("  try {", releaseTransportStart);
  const releaseTransport = host.slice(releaseTransportStart, setupTry);
  assert.match(releaseTransport, /c08MaintenanceBarrier\.orphan\(maintenanceOwner\);/u);
  assert.doesNotMatch(releaseTransport, /c08MaintenanceBarrier\.release/u);
  assert.match(host, /transport\.onclose = \(\) => \{\n      releaseTransport\(\);/u);
  assert.match(host, /transport\.onerror = \(\) => \{\n      releaseTransport\(\);/u);
  assert.match(host, /c08MaintenanceBarrier\.orphanIfLeaseInactive\(evaluationLease\.active\);/u);
});

test("explicit release validates the exact live session and preserves delete-retire-receipt order", () => {
  const start = host.indexOf('app.post(\n  "/maintenance/:token/release"');
  const end = host.indexOf('\napp.get("/maintenance/:token/release-receipt"', start);
  assert.ok(start >= 0 && end > start);
  const route = host.slice(start, end);
  assert.match(route, /express\.json\(\{ limit: "1kb", strict: true \}\)/u);
  assert.match(route, /Object\.keys\(body as Record<string, unknown>\)\.length !== 1/u);
  assert.match(route, /hasOwnProperty\.call\(body, "terminal_sha256"\)/u);
  assert.match(route, /typeof \(body as Record<string, unknown>\)\.terminal_sha256 !== "string"/u);
  const sessionGuard = route.indexOf("exclusiveEvaluationLease.sessionCanAccess(entry.leaseOwner)");
  const ownerGuard = route.indexOf("c08MaintenanceBarrier.ownerMatches(entry.maintenanceOwner)");
  const durableDelete = route.indexOf("const receipt = c08MaintenanceBarrier.release(");
  const retire = route.indexOf("retireSession(sid, entry);", durableDelete);
  const response = route.indexOf("res.json(receipt);", retire);
  assert.ok(sessionGuard >= 0 && ownerGuard > sessionGuard);
  const inactiveBranch = route.slice(sessionGuard, ownerGuard);
  assert.match(inactiveBranch, /retireSession\(sid, entry\);/u);
  assert.doesNotMatch(inactiveBranch, /c08MaintenanceBarrier\.release/u);
  assert.ok(durableDelete > ownerGuard, "fence deletion requires exact live owner validation");
  assert.match(route.slice(durableDelete, retire), /entry\.maintenanceOwner,\n        sid,\n        terminalSha256,/u);
  assert.doesNotMatch(route, /lookupReleaseReceipt/u, "POST remains a one-shot release mutation");
  assert.ok(retire > durableDelete, "exact session and lease retire only after durable fence deletion");
  assert.ok(response > retire, "receipt is returned only after exact retirement");
});

test("release record is durable before unlink and becomes replayable only after deletion", () => {
  const start = barrier.indexOf("  release(\n");
  const end = barrier.indexOf("\n  lookupReleaseReceipt(", start);
  const release = barrier.slice(start, end);
  const durableRecord = release.indexOf("writeCreateNewDurable(");
  const recordIndexed = release.indexOf("this.releaseRecordsByFence.set(", durableRecord);
  const unlink = release.indexOf("fs.unlinkSync(this.fencePath);", recordIndexed);
  const completed = release.indexOf("this.completedReleasesBySession.set(", unlink);
  assert.ok(durableRecord >= 0);
  assert.ok(recordIndexed > durableRecord);
  assert.ok(unlink > recordIndexed, "durable release record must precede fence unlink");
  assert.ok(completed > unlink, "receipt lookup becomes visible only after fence deletion");
});

test("release-receipt GET is an exact read-only lookup independent of live sessions", () => {
  const start = host.indexOf('app.get("/maintenance/:token/release-receipt"');
  const end = host.indexOf('\napp.get("/health"', start);
  assert.ok(start >= 0 && end > start);
  const route = host.slice(start, end);
  assert.match(route, /requestLeaseHeader\(req\)/u);
  assert.match(route, /requestMaintenancePurposeHeader\(req\)/u);
  assert.match(route, /requestSessionId\(req\)/u);
  assert.match(route, /queryKeys\.length !== 1/u);
  assert.match(route, /queryKeys\[0\] !== "terminal_sha256"/u);
  const lookup = route.indexOf("c08MaintenanceBarrier.lookupReleaseReceipt(");
  const response = route.indexOf("res.json(receipt);", lookup);
  assert.ok(lookup >= 0 && response > lookup);
  assert.doesNotMatch(route, /sessions\.(?:get|set|delete)/u);
  assert.doesNotMatch(route, /retireSession|c08MaintenanceBarrier\.release\(|unlinkSync|writeCreateNewDurable/u);
});

test("release errors and receipts never claim an unobserved fence-retention state", () => {
  assert.doesNotMatch(host, /fence_retained/u);
  assert.doesNotMatch(barrier, /fence_retained/u);
});

test("health exposes the exact maintenance object and both new activity counters", () => {
  const start = host.indexOf('app.get("/health"');
  const end = host.indexOf("\napp.use(", start);
  const health = host.slice(start, end);
  assert.match(
    health,
    /const maintenanceBarrier = await maintenanceBarrierHealth\(\n    maintenanceHeader\.purpose === C08_MAINTENANCE_PURPOSE \? leaseHeader\.id : null,\n  \);/u,
  );
  assert.match(health, /\n    maintenanceBarrier,/u);
  assert.match(health, /activeHealthPrewarms,/u);
  assert.match(health, /activeWritePlaneRecoveries,/u);
  assert.match(
    barrier,
    /schema: C08_MAINTENANCE_HEALTH_SCHEMA,[\s\S]*purpose:[\s\S]*phase:[\s\S]*durable:[\s\S]*owner_match:[\s\S]*host_instance_id:[\s\S]*write_plane_root_sha256:[\s\S]*fence_sha256:[\s\S]*recovery_fixed_point:[\s\S]*quiescence,/u,
  );
});
