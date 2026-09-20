// US-9: parses the Playwright JSON reporter output and forwards it to TestMind's ingest
// endpoint. This repo doesn't know or care how the results get analyzed — it just ships them.
//
// Playwright's report has no concept of "HTTP method/path/expected status" (that's our own
// testing convention, not Playwright's), so those are derived heuristically from two
// conventions every spec file in this repo already follows: `test.describe("Contract: <path>")`
// and test titles that start with the HTTP verb (e.g. "POST creates a subscription invoice...").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const resultsPath = fileURLToPath(new URL("../test-results/results.json", import.meta.url));
const target = process.argv[2] || "mock";
const ingestUrl = process.env.TESTMIND_INGEST_URL;
const apiKey = process.env.TESTMIND_API_KEY;

const STATUS_CODE_RE = /\b(200|201|204|401|403|404|409|422|429|500)\b/;
const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE)\b/i;

function deriveMethodAndPath(describeTitles: string[], testTitle: string) {
  const pathMatch = describeTitles.join(" ").match(/Contract:\s*(\S+)/);
  const path = pathMatch ? pathMatch[1] : describeTitles[describeTitles.length - 1] || "unknown";
  const methodMatch = testTitle.match(METHOD_RE);
  const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
  return { method, path };
}

function deriveCategory(describeTitles: string[]) {
  if (describeTitles.some((t) => /mutations/i.test(t))) return "mutation";
  return "contract";
}

function deriveExpectedStatus(testTitle: string) {
  const m = testTitle.match(STATUS_CODE_RE);
  return m ? Number(m[1]) : 200;
}

function collectResults(suite: any, describeTitles: string[] = []): any[] {
  const out: any[] = [];
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result = test.results?.[test.results.length - 1];
      const status = result?.status;
      if (!status || status === "skipped") continue;
      const { method, path } = deriveMethodAndPath(describeTitles, spec.title);
      out.push({
        scenario_name: [...describeTitles, spec.title].join(" › "),
        category: deriveCategory(describeTitles),
        method,
        path,
        expected_status: deriveExpectedStatus(spec.title),
        actual_status: null,
        passed: status === "passed",
        latency_ms: result?.duration ?? null,
        error_message: result?.error?.message ?? null,
        request_body: null,
        response_body: null,
      });
    }
  }
  for (const child of suite.suites ?? []) {
    out.push(...collectResults(child, [...describeTitles, child.title]));
  }
  return out;
}

async function main() {
  if (!ingestUrl || !apiKey) {
    console.log("TESTMIND_INGEST_URL/TESTMIND_API_KEY not set — skipping results ingest.");
    return;
  }

  const report = JSON.parse(readFileSync(resultsPath, "utf-8"));
  const results: any[] = [];
  for (const suite of report.suites ?? []) {
    results.push(...collectResults(suite));
  }

  if (results.length === 0) {
    console.log("No non-skipped results to send.");
    return;
  }

  const res = await fetch(ingestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ target, results }),
  });

  if (!res.ok) {
    throw new Error(`Failed to send results to TestMind: HTTP ${res.status} — ${await res.text()}`);
  }
  console.log(`Sent ${results.length} results to TestMind (target=${target}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
