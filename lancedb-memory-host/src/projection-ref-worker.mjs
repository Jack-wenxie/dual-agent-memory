// Worker entry for loadProjectionInWorker: one shared projection load off the host event loop.
// Any failure posts no maps, so the resolver withholds refs exactly as for an unreadable projection.
import { parentPort, workerData } from "node:worker_threads";

import { loadProjectionRefMap } from "../../mqe/projection/projection_contract.mjs";

let loaded = null;
try {
  loaded = loadProjectionRefMap({ dataDir: workerData.dataDir });
} catch {}
parentPort.postMessage({ loaded });
