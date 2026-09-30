import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

const PATH = "/api/facturen/revenue-by-week";

async function getOperation(baseUrl: string) {
  const contract = await loadContract(baseUrl);
  const op = operationsForPrefix(contract, "/api/facturen").find((o) => o.path === PATH && o.method === "get");
  return { contract, op };
}

// Dates are compared as plain YYYY-MM-DD strings in UTC so the local TZ of the runner can't
// shift a day across a week boundary.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function isoWeekNumber(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

test.describe(`Contract: ${PATH}`, () => {
  test("contract defines GET returning an array of RevenueByWeekOut", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await getOperation(baseUrl);
    expect(op, `contract must define GET ${PATH}`).toBeTruthy();

    const schema = op!.operation.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(schema?.type).toBe("array");
    expect(responseSchemaName(op!.operation, "200")).toBe("RevenueByWeekOut");
  });

  test("GET returns a list matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { contract, op } = await getOperation(baseUrl);
    expect(op, `contract must define GET ${PATH}`).toBeTruthy();

    const res = await ownerApi.get(PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const schemaName = responseSchemaName(op!.operation, "200");
    if (schemaName) {
      for (const row of body) assertMatchesSchema(contract, schemaName, row);
    }
  });

  // Read-only invariants of the aggregation, safe to check against whatever data live holds.
  test("GET buckets are Monday–Sunday ISO weeks, unique, and newest first", async ({ ownerApi }) => {
    const res = await ownerApi.get(PATH);
    expect(res.status()).toBe(200);
    const body: any[] = await res.json();

    for (const row of body) {
      expect(new Date(`${row.week_start}T00:00:00Z`).getUTCDay(), `${row.week_start} must be a Monday`).toBe(1);
      expect(row.week_end).toBe(addDays(row.week_start, 6));
      expect(row.week_number).toBe(isoWeekNumber(row.week_start));
      // A week only appears because at least one dated factuur fell in it.
      expect(row.invoice_count).toBeGreaterThanOrEqual(1);
    }

    const starts = body.map((r) => r.week_start);
    expect(new Set(starts).size, "each week must appear once").toBe(starts.length);
    expect(starts).toEqual([...starts].sort().reverse());
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`);
    expect(res.status).toBe(401);
  });

  test("GET with a forged session cookie is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`, { headers: { Cookie: "session=forged.not-signed" } });
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    test("GET with only an X-API-Key (no session) is rejected", async ({ apiKeyHeaders }, testInfo) => {
      // The machine client's key authorises writes, not reads of the owner's revenue.
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}${PATH}`, { headers: apiKeyHeaders });
      expect(res.status).toBe(401);
    });

    // The endpoint aggregates over the whole table, so each test seeds a week far in the past
    // that no other spec writes to, and asserts on the delta against that week's prior state.
    function uniqueMonday(): string {
      // Mondays between 1980 and ~2000 — 1980-01-07 is a Monday.
      const weeks = Math.floor(Math.random() * 1000);
      return addDays("1980-01-07", weeks * 7);
    }

    async function weekRow(ownerApi: any, weekStart: string) {
      const res = await ownerApi.get(PATH);
      expect(res.status()).toBe(200);
      const body: any[] = await res.json();
      return body.find((r) => r.week_start === weekStart);
    }

    async function createFactuur(baseUrl: string, apiKeyHeaders: Record<string, string>, fields: Record<string, unknown>) {
      const res = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({
          factuur: `TEST-RW-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...fields,
        }),
      });
      expect(res.status, "setup: POST /api/facturen must succeed").toBe(200);
      return res.json();
    }

    test("facturen in the same Mon–Sun week are summed into one bucket", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await getOperation(baseUrl);
      const monday = uniqueMonday();
      const before = await weekRow(ownerApi, monday);
      const baseTotal = before?.total ?? 0;
      const baseCount = before?.invoice_count ?? 0;

      // Monday and Sunday are the two edges of the bucket.
      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: monday, totaal: 100.25 });
      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: addDays(monday, 6), totaal: 49.75 });

      const row = await weekRow(ownerApi, monday);
      expect(row, `week starting ${monday} must be present`).toBeTruthy();
      expect(row.week_end).toBe(addDays(monday, 6));
      expect(row.week_number).toBe(isoWeekNumber(monday));
      expect(row.invoice_count).toBe(baseCount + 2);
      expect(row.total).toBeCloseTo(baseTotal + 150, 2);

      const schemaName = responseSchemaName(op!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, row);
    });

    test("a factuur on the following Monday lands in the next week's bucket", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const nextMonday = addDays(monday, 7);
      const beforeThis = await weekRow(ownerApi, monday);
      const beforeNext = await weekRow(ownerApi, nextMonday);

      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: nextMonday, totaal: 10 });

      const afterThis = await weekRow(ownerApi, monday);
      const afterNext = await weekRow(ownerApi, nextMonday);
      expect(afterThis?.invoice_count ?? 0).toBe(beforeThis?.invoice_count ?? 0);
      expect(afterNext.invoice_count).toBe((beforeNext?.invoice_count ?? 0) + 1);
    });

    test("facturen without a factuurdatum are excluded rather than guessed", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      // Compares the count across ALL weeks: safe under parallel workers because no other spec
      // creates a factuur with a factuurdatum, and tests in this file run serially.
      const baseUrl = baseUrlFor(testInfo.project.name);
      const before: any[] = await (await ownerApi.get(PATH)).json();

      await createFactuur(baseUrl, apiKeyHeaders, { totaal: 777.77 });

      const after: any[] = await (await ownerApi.get(PATH)).json();
      const sum = (rows: any[]) => rows.reduce((acc, r) => acc + r.invoice_count, 0);
      expect(sum(after)).toBe(sum(before));
    });

    test("a re-POSTed identical factuur (upsert dedup) is counted once", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const before = await weekRow(ownerApi, monday);
      const baseCount = before?.invoice_count ?? 0;
      const baseTotal = before?.total ?? 0;

      const payload = { factuur: `TEST-RW-DUP-${Date.now()}`, factuurdatum: addDays(monday, 2), totaal: 33.33 };
      const first = await createFactuur(baseUrl, apiKeyHeaders, payload);
      const second = await createFactuur(baseUrl, apiKeyHeaders, payload);
      expect(second.id).toBe(first.id);

      const row = await weekRow(ownerApi, monday);
      expect(row.invoice_count).toBe(baseCount + 1);
      expect(row.total).toBeCloseTo(baseTotal + 33.33, 2);
    });

    test("same factuur with a different totaal is a separate row and both amounts count", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      // Uniqueness is on (factuur, totaal): a changed amount is a discrepancy kept as its own row.
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const before = await weekRow(ownerApi, monday);
      const baseCount = before?.invoice_count ?? 0;
      const baseTotal = before?.total ?? 0;

      const factuur = `TEST-RW-DISC-${Date.now()}`;
      const first = await createFactuur(baseUrl, apiKeyHeaders, { factuur, factuurdatum: monday, totaal: 20 });
      const second = await createFactuur(baseUrl, apiKeyHeaders, { factuur, factuurdatum: monday, totaal: 25 });
      expect(second.id).not.toBe(first.id);

      const row = await weekRow(ownerApi, monday);
      expect(row.invoice_count).toBe(baseCount + 2);
      expect(row.total).toBeCloseTo(baseTotal + 45, 2);
    });
  });
});
