// Compares the live /openapi.json against the committed snapshot (US-1). Exits non-zero on any
// difference — used by generate-tests.yml (US-8, not built yet) to decide whether to kick off
// AI test generation, and useful to run by hand any time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIVE_BASE_URL } from "../env.js";

const snapshotPath = fileURLToPath(new URL("../contracts/openapi-snapshot.json", import.meta.url));
const baseUrl = process.argv[2] || LIVE_BASE_URL;

async function main() {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
  const res = await fetch(`${baseUrl}/openapi.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${baseUrl}/openapi.json: HTTP ${res.status}`);
  }
  const live = await res.json();

  const same = JSON.stringify(live) === JSON.stringify(snapshot);
  if (same) {
    console.log("No drift: live /openapi.json matches the committed snapshot.");
    return;
  }

  console.log(`Drift detected between ${baseUrl}/openapi.json and the committed snapshot.`);
  const liveOps = new Set(Object.keys(live.paths ?? {}));
  const snapshotOps = new Set(Object.keys(snapshot.paths ?? {}));
  for (const path of liveOps) {
    if (!snapshotOps.has(path)) console.log(`  + new path: ${path}`);
  }
  for (const path of snapshotOps) {
    if (!liveOps.has(path)) console.log(`  - removed path: ${path}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
