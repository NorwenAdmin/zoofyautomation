import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor, MOCK_API_KEY } from "../env.js";

const PATH = "/api/facturen/revenue-by-week";

// Read-only aggregate over the existing `facturen` table (no new resource): SUM(totaal) and
// COUNT(*) grouped by date_trunc('week', factuurdatum), newest week first, rows without a
// factuurdatum excluded. Both targets implement it, so a missing operation is a hard failure
// (same as subscription-invoices.spec.ts).
async function getOperation(baseUrl: string) {
  const contract = await loadContract(baseUrl);
  const op = operationsForPrefix(contract, "/api/facturen").find((o) => o.path === PATH && o.method === "get");
  expect(op, `contract must define GET ${PATH}`).toBeTruthy();
  return { contract, op: op! };
}

type Week = { week_number: number; week_start: string; week_end: string; total: number; invoice_count: number };

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoWeekNumber(isoDate: string): number {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
}

test.describe(`Contract: ${PATH}`, () => {
  test("contract defines GET returning an array of RevenueByWeekOut", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await getOperation(baseUrl);

    const schema = op.operation.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(schema?.type).toBe("array");
    expect(responseSchemaName(op.operation, "200")).toBe("RevenueByWeekOut");
  });

  test("GET returns a list matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { contract, op } = await getOperation(baseUrl);

    const res = await ownerApi.get(PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const schemaName = responseSchemaName(op.operation, "200");
    if (schemaName) {
      for (const row of body) assertMatchesSchema(contract, schemaName, row);
    }
  });

  test("GET rows are Monday-anchored ISO weeks, newest first", async ({ ownerApi }) => {
    const res = await ownerApi.get(PATH);
    expect(res.status()).toBe(200);
    const body: Week[] = await res.json();

    for (const row of body) {
      expect(new Date(`${row.week_start}T00:00:00Z`).getUTCDay(), `${row.week_start} must be a Monday`).toBe(1);
      expect(row.week_end).toBe(addDays(row.week_start, 6));
      expect(row.week_number).toBe(isoWeekNumber(row.week_start));
      expect(row.invoice_count).toBeGreaterThanOrEqual(1);
    }
    const starts = body.map((r) => r.week_start);
    expect(starts).toEqual([...starts].sort().reverse());
    expect(new Set(starts).size, "each week appears at most once").toBe(starts.length);
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`);
    expect(res.status).toBe(401);
  });

  test("GET with a forged session cookie is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`, { headers: { Cookie: "session=not-a-real-session" } });
    expect(res.status).toBe(401);
  });

  test("GET with only an X-API-Key (no owner session) is rejected", async ({}, testInfo) => {
    // The machine client may write facturen, but revenue figures are owner-only. (On live this
    // key is just wrong, which must also be rejected.)
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`, { headers: { "X-API-Key": MOCK_API_KEY } });
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    // Each test seeds into its own random Monday in the distant past, so it owns that week's
    // bucket outright and never collides with seed data, other tests, or earlier runs against
    // the same mock database.
    function randomMonday(): string {
      const base = Date.UTC(1950, 0, 2); // a Monday
      const weeks = Math.floor(Math.random() * 52 * 45);
      return new Date(base + weeks * 7 * 86400000).toISOString().slice(0, 10);
    }

    async function createFactuur(
      baseUrl: string,
      apiKeyHeaders: Record<string, string>,
      fields: Record<string, unknown>
    ) {
      const res = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({
          factuur: `TEST-REV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...fields,
        }),
      });
      expect(res.status, "setup: POST /api/facturen must succeed").toBe(200);
      return res.json();
    }

    async function weeks(ownerApi: import("@playwright/test").APIRequestContext): Promise<Week[]> {
      const res = await ownerApi.get(PATH);
      expect(res.status()).toBe(200);
      return res.json();
    }

    test("facturen in the same week are summed and counted into one bucket", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await getOperation(baseUrl);
      const monday = randomMonday();

      // Monday and Sunday bound the same week; the next Monday starts a new one.
      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: monday, totaal: 100.25 });
      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: addDays(monday, 3), totaal: 50.5 });
      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: addDays(monday, 6), totaal: 10 });
      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: addDays(monday, 7), totaal: 7 });

      const body = await weeks(ownerApi);
      const week = body.find((w) => w.week_start === monday);
      expect(week, `expected a bucket for week starting ${monday}`).toBeTruthy();
      expect(week!.week_end).toBe(addDays(monday, 6));
      expect(week!.week_number).toBe(isoWeekNumber(monday));
      expect(week!.invoice_count).toBe(3);
      expect(week!.total).toBeCloseTo(160.75, 2);

      const next = body.find((w) => w.week_start === addDays(monday, 7));
      expect(next, "the following Monday must land in its own bucket").toBeTruthy();
      expect(next!.invoice_count).toBe(1);
      expect(next!.total).toBeCloseTo(7, 2);

      const schemaName = responseSchemaName(op.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, week);
    });

    test("facturen without a factuurdatum are excluded rather than guessed into a week", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const before = await weeks(ownerApi);

      const undated = await createFactuur(baseUrl, apiKeyHeaders, { totaal: 999.99 });
      expect(undated.factuurdatum).toBeNull();

      const after = await weeks(ownerApi);
      const count = (ws: Week[]) => ws.reduce((n, w) => n + w.invoice_count, 0);
      expect(count(after)).toBe(count(before));
      expect(after.map((w) => w.week_start)).toEqual(before.map((w) => w.week_start));
    });

    test("re-POSTing the same factuur+totaal is not double-counted (upsert)", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = randomMonday();
      const payload = { factuur: `TEST-REV-DUP-${Date.now()}`, factuurdatum: addDays(monday, 2), totaal: 42.5 };

      const first = await createFactuur(baseUrl, apiKeyHeaders, payload);
      const second = await createFactuur(baseUrl, apiKeyHeaders, payload);
      expect(second.id).toBe(first.id);

      const week = (await weeks(ownerApi)).find((w) => w.week_start === monday);
      expect(week).toBeTruthy();
      expect(week!.invoice_count).toBe(1);
      expect(week!.total).toBeCloseTo(42.5, 2);
    });

    test("the same factuur with a different totaal counts as its own row", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      // uq_facturen_factuur_totaal keeps amount corrections as separate rows, so the weekly
      // total includes both — revenue reflects exactly what's stored.
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = randomMonday();
      const factuur = `TEST-REV-CORR-${Date.now()}`;

      await createFactuur(baseUrl, apiKeyHeaders, { factuur, factuurdatum: monday, totaal: 20 });
      await createFactuur(baseUrl, apiKeyHeaders, { factuur, factuurdatum: monday, totaal: 25 });

      const week = (await weeks(ownerApi)).find((w) => w.week_start === monday);
      expect(week).toBeTruthy();
      expect(week!.invoice_count).toBe(2);
      expect(week!.total).toBeCloseTo(45, 2);
    });

    test("a dated factuur with no totaal is counted without breaking the numeric total", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await getOperation(baseUrl);
      const monday = randomMonday();

      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: monday, totaal: 30 });
      await createFactuur(baseUrl, apiKeyHeaders, { factuurdatum: addDays(monday, 1) });

      const week = (await weeks(ownerApi)).find((w) => w.week_start === monday);
      expect(week).toBeTruthy();
      expect(week!.invoice_count).toBe(2);
      expect(week!.total).toBeCloseTo(30, 2);

      const schemaName = responseSchemaName(op.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, week);
    });
  });
});
