import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

const PATH = "/api/facturen/revenue-by-week";

// US-1: scenarios are derived from the target's own live /openapi.json. Like facturen.spec.ts,
// a target whose contract doesn't expose this (drifted) endpoint yet skips rather than fails —
// `npm run check-drift` is what reports the drift itself.
async function getOperation(baseUrl: string) {
  const contract = await loadContract(baseUrl);
  const op = operationsForPrefix(contract, "/api/facturen").find((o) => o.path === PATH && o.method === "get");
  return { contract, op };
}

const NOT_IN_CONTRACT = `this target's /openapi.json does not define GET ${PATH} yet (see 'npm run check-drift')`;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

// ISO-8601 week number, computed independently of the backend's Python isocalendar().
function isoWeekNumber(isoDay: string): number {
  const d = new Date(`${isoDay}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

test.describe(`Contract: ${PATH}`, () => {
  test("GET returns weekly revenue rows matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { contract, op } = await getOperation(baseUrl);
    test.skip(!op, NOT_IN_CONTRACT);

    const res = await ownerApi.get(PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const schemaName = responseSchemaName(op!.operation, "200");
    expect(schemaName).toBe("RevenueByWeekOut");
    for (const row of body) assertMatchesSchema(contract, schemaName!, row);
  });

  test("GET rows are Monday–Sunday ISO weeks, unique and newest first", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await getOperation(baseUrl);
    test.skip(!op, NOT_IN_CONTRACT);

    const body: any[] = await (await ownerApi.get(PATH)).json();
    for (const row of body) {
      expect(new Date(`${row.week_start}T00:00:00Z`).getUTCDay(), `${row.week_start} must be a Monday`).toBe(1);
      expect(row.week_end).toBe(addDays(row.week_start, 6));
      expect(row.week_number).toBe(isoWeekNumber(row.week_start));
      // Weeks come from GROUP BY over rows that exist, so an empty week is never emitted.
      expect(row.invoice_count).toBeGreaterThanOrEqual(1);
    }
    const starts = body.map((r) => r.week_start);
    expect(new Set(starts).size).toBe(starts.length);
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await getOperation(baseUrl);
    test.skip(!op, NOT_IN_CONTRACT);

    const res = await fetch(`${baseUrl}${PATH}`);
    expect(res.status).toBe(401);
  });

  test("GET with a forged session cookie is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await getOperation(baseUrl);
    test.skip(!op, NOT_IN_CONTRACT);

    const res = await fetch(`${baseUrl}${PATH}`, { headers: { Cookie: "session=not-a-real-signed-session" } });
    expect(res.status).toBe(401);
  });

  test("GET with an X-API-Key but no session is rejected (owner-only, not machine-readable)", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await getOperation(baseUrl);
    test.skip(!op, NOT_IN_CONTRACT);

    const res = await fetch(`${baseUrl}${PATH}`, { headers: { "X-API-Key": "wrong-key" } });
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    // Every test gets its own random week far in the past so parallel workers (and the other
    // facturen specs, which post undated rows) can't bleed into the totals being asserted.
    function isolatedMonday(): string {
      const base = Date.UTC(1950, 0, 2); // a Monday
      const weeks = Math.floor(Math.random() * 2000);
      return isoDate(new Date(base + weeks * 7 * 86400000));
    }

    async function postFactuur(baseUrl: string, apiKeyHeaders: Record<string, string>, body: Record<string, unknown>) {
      const res = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify(body),
      });
      expect(res.status, "setup: POST /api/facturen must succeed").toBe(200);
      return res.json();
    }

    async function weekRow(ownerApi: any, weekStart: string) {
      const res = await ownerApi.get(PATH);
      expect(res.status()).toBe(200);
      const body: any[] = await res.json();
      return body.find((r) => r.week_start === weekStart);
    }

    const uniqueFactuur = () => `TEST-RBW-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    test("facturen dated Monday through Sunday are summed into one week matching the schema", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await getOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const monday = isolatedMonday();
      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur(), totaal: 100.25, factuurdatum: monday });
      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur(), totaal: 50.5, factuurdatum: addDays(monday, 3) });
      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur(), totaal: 9.99, factuurdatum: addDays(monday, 6) });
      // The next Monday belongs to the following week, not this one.
      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur(), totaal: 1000, factuurdatum: addDays(monday, 7) });

      const row = await weekRow(ownerApi, monday);
      expect(row, `a row for week starting ${monday}`).toBeTruthy();
      expect(row.invoice_count).toBe(3);
      expect(row.total).toBeCloseTo(160.74, 2);
      expect(row.week_end).toBe(addDays(monday, 6));
      expect(row.week_number).toBe(isoWeekNumber(monday));
      assertMatchesSchema(contract, responseSchemaName(op!.operation, "200")!, row);

      const next = await weekRow(ownerApi, addDays(monday, 7));
      expect(next.invoice_count).toBe(1);
      expect(next.total).toBeCloseTo(1000, 2);
    });

    test("a factuur without factuurdatum is excluded rather than guessed into a week", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await getOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const created = await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur(), totaal: 77.77 });
      expect(created.factuurdatum).toBeNull();

      // Report first, list second: the list can only have grown in between, and it contains our
      // undated row — so if undated rows were bucketed, the counts would be equal instead.
      const report: any[] = await (await ownerApi.get(PATH)).json();
      const list: any[] = await (await ownerApi.get("/api/facturen")).json();
      const reported = report.reduce((n, r) => n + r.invoice_count, 0);
      expect(list.some((f) => f.id === created.id)).toBe(true);
      expect(reported).toBeLessThan(list.length);
    });

    test("re-posting the same factuur+totaal (n8n retry) is not double-counted", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await getOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const monday = isolatedMonday();
      const payload = { factuur: uniqueFactuur(), totaal: 42.5, factuurdatum: addDays(monday, 2) };
      const first = await postFactuur(baseUrl, apiKeyHeaders, payload);
      const second = await postFactuur(baseUrl, apiKeyHeaders, payload);
      expect(second.id).toBe(first.id);

      const row = await weekRow(ownerApi, monday);
      expect(row.invoice_count).toBe(1);
      expect(row.total).toBeCloseTo(42.5, 2);
    });

    test("the same factuur with a different totaal (a Zoofy correction) counts as its own row", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await getOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const monday = isolatedMonday();
      const factuur = uniqueFactuur();
      await postFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 10, factuurdatum: monday });
      await postFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 12.5, factuurdatum: monday });

      const row = await weekRow(ownerApi, monday);
      expect(row.invoice_count).toBe(2);
      expect(row.total).toBeCloseTo(22.5, 2);
    });

    test("a factuur with an invalid factuurdatum is rejected with 422 and never reaches the report", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await getOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const factuur = uniqueFactuur();
      const res = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ factuur, totaal: 5, factuurdatum: "2024-13-45" }),
      });
      expect(res.status).toBe(422);

      const list: any[] = await (await ownerApi.get("/api/facturen")).json();
      expect(list.some((f) => f.factuur === factuur)).toBe(false);
      const report: any[] = await (await ownerApi.get(PATH)).json();
      expect(report.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.week_start))).toBe(true);
    });
  });
});
