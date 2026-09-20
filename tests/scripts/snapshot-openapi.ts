// Captures the live OpenAPI contract as the committed baseline for drift detection (US-1).
// Run manually after intentionally changing the API: `npm run snapshot-openapi -- <base-url>`.
// Defaults to the mock stack's URL since that's what's usually running locally; pass the live
// URL explicitly to snapshot from production instead.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MOCK_BASE_URL } from "../env.js";

const baseUrl = process.argv[2] || MOCK_BASE_URL;
const outPath = fileURLToPath(new URL("../contracts/openapi-snapshot.json", import.meta.url));

async function main() {
  const res = await fetch(`${baseUrl}/openapi.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${baseUrl}/openapi.json: HTTP ${res.status}`);
  }
  const contract = await res.json();
  writeFileSync(outPath, JSON.stringify(contract, null, 2) + "\n");
  console.log(`Snapshot written to ${outPath} (from ${baseUrl}/openapi.json)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
