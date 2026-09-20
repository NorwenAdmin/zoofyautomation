import { test, expect } from "../fixtures/auth.js";

// US-6: a loose p95 threshold — the point is catching a severe regression (e.g. an accidental
// N+1 query, a connection pool exhausted, a missing index), not fine-grained perf tuning.
const P95_THRESHOLD_MS = 2000;
const SAMPLE_COUNT = 10;

function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))];
}

test.describe("Non-functional: GET latency", () => {
  for (const path of ["/api/subscriptions", "/api/appointments", "/api/facturen"]) {
    test(`GET ${path} stays under the p95 latency threshold`, { tag: "@nonfunctional" }, async ({ ownerApi }) => {
      const durations: number[] = [];
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const start = Date.now();
        const res = await ownerApi.get(path);
        durations.push(Date.now() - start);
        expect(res.status()).toBe(200);
      }
      durations.sort((a, b) => a - b);
      const p95 = percentile(durations, 95);
      expect(p95, `p95 latency for ${path} was ${p95}ms (samples: ${durations.join(", ")}ms)`).toBeLessThan(
        P95_THRESHOLD_MS
      );
    });
  }
});
