import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

const PATH = "/api/facturen/revenue-by-week";

async function revenueOperation(baseUrl: string) {
  const contract = await loadContract(baseUrl);
  const op = operationsForPrefix(contract, "/api/facturen").find(
    (o) => o.path === PATH && o.method === "get"
  );
  return { contract, op };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ISO-8601 week number — what the backend reports via date.isocalendar()[1].
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

// The mock stack's Postgres is shared by every spec in a run, and other specs create facturen
// with real-ish dates — so each aggregation test puts its rows in a week of the 1990s that
// nothing else writes to, and only asserts on that week's row.
const BASE_MONDAY = Date.UTC(1990, 0, 1); // 1990-01-01 was a Monday
let nextWeekOffset = Date.now() % 500;
function uniqueMonday(): Date {
  return new Date(BASE_MONDAY + nextWeekOffset++ * 7 * DAY_MS);
}

function uniqueFactuur(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe(`Contract: ${PATH}`, () => {
  test("contract defines GET returning a RevenueByWeekOut list", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { contract, op } = await revenueOperation(baseUrl);
    expect(op, `contract must define GET ${PATH}`).toBeTruthy();

    const schema = op!.operation.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(schema?.type).toBe("array");
    expect(responseSchemaName(op!.operation, "200")).toBe("RevenueByWeekOut");
    expect(op!.operation.requestBody, "a GET aggregate takes no request body").toBeUndefined();

    const required = contract.components?.schemas?.RevenueByWeekOut?.required ?? [];
    expect([...required].sort()).toEqual(["invoice_count", "total", "week_end", "week_number", "week_start"]);
  });

  test("GET returns a list matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { contract, op } = await revenueOperation(baseUrl);
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

  test("every week row is a consistent Monday–Sunday ISO week, most recent first", async ({ ownerApi }) => {
    const res = await ownerApi.get(PATH);
    expect(res.status()).toBe(200);
    const body: any[] = await res.json();

    const seen = new Set<string>();
    for (let i = 0; i < body.length; i++) {
      const row = body[i];
      const start = parseIsoDate(row.week_start);
      expect(start.getUTCDay(), `week_start ${row.week_start} must be a Monday`).toBe(1);
      expect(row.week_end).toBe(toIsoDate(new Date(start.getTime() + 6 * DAY_MS)));
      expect(row.week_number).toBe(isoWeekNumber(start));
      expect(row.invoice_count, "a week only appears if it has at least one factuur").toBeGreaterThanOrEqual(1);

      expect(seen.has(row.week_start), `week ${row.week_start} must appear only once`).toBe(false);
      seen.add(row.week_start);
      if (i > 0) {
        // ISO "YYYY-MM-DD", so lexicographic order is chronological order.
        expect(body[i - 1].week_start > row.week_start, "weeks must be ordered most recent first").toBe(true);
      }
    }
  });

  test("invoice counts add up to the facturen that have a factuurdatum", async ({ ownerApi }) => {
    const [weeksRes, facturenRes] = await Promise.all([ownerApi.get(PATH), ownerApi.get("/api/facturen")]);
    expect(weeksRes.status()).toBe(200);
    expect(facturenRes.status()).toBe(200);
    const weeks: any[] = await weeksRes.json();
    const facturen: any[] = await facturenRes.json();

    const counted = weeks.reduce((sum, w) => sum + w.invoice_count, 0);
    const dated = facturen.filter((f) => f.factuurdatum !== null).length;
    // Rows without a factuurdatum can't be placed in a week, so they're excluded, not guessed.
    expect(counted).toBe(dated);
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`);
    expect(res.status).toBe(401);
  });

  test("GET with a forged session cookie is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`, {
      headers: { Cookie: "session=eyJ1c2VyX2lkIjogMX0=.forged.signature" },
    });
    expect(res.status).toBe(401);
  });

  test("GET with an X-API-Key but no session is rejected (owner-only endpoint)", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`, { headers: { "X-API-Key": "wrong-key" } });
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    async function postFactuur(
      baseUrl: string,
      apiKeyHeaders: Record<string, string>,
      payload: Record<string, unknown>
    ) {
      const res = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify(payload),
      });
      expect(res.status, "setup: POST /api/facturen must succeed").toBe(200);
      return res.json();
    }

    async function weekRow(ownerApi: any, weekStart: string) {
      const res = await ownerApi.get(PATH);
      expect(res.status()).toBe(200);
      const body: any[] = await res.json();
      return body.find((w) => w.week_start === weekStart);
    }

    test("facturen in the same week are summed and counted into one row matching the contract schema", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await revenueOperation(baseUrl);
      expect(op, `contract must define GET ${PATH}`).toBeTruthy();

      const monday = uniqueMonday();
      const sunday = new Date(monday.getTime() + 6 * DAY_MS);
      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur("TEST-REV"), totaal: 100.25, factuurdatum: toIsoDate(monday) });
      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur("TEST-REV"), totaal: 50.5, factuurdatum: toIsoDate(sunday) });

      const row = await weekRow(ownerApi, toIsoDate(monday));
      expect(row, `expected a revenue row for the week of ${toIsoDate(monday)}`).toBeTruthy();
      expect(row.week_end).toBe(toIsoDate(sunday));
      expect(row.week_number).toBe(isoWeekNumber(monday));
      expect(row.invoice_count).toBe(2);
      expect(row.total).toBeCloseTo(150.75, 2);

      const schemaName = responseSchemaName(op!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, row);
    });

    test("a factuur on the following Monday lands in its own week", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      // Reserve two consecutive weeks so the "next" one isn't handed to another test.
      const monday = uniqueMonday();
      const nextMonday = uniqueMonday();
      expect(nextMonday.getTime() - monday.getTime()).toBe(7 * DAY_MS);

      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur("TEST-REV"), totaal: 10, factuurdatum: toIsoDate(monday) });
      await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur("TEST-REV"), totaal: 20, factuurdatum: toIsoDate(nextMonday) });

      const first = await weekRow(ownerApi, toIsoDate(monday));
      const second = await weekRow(ownerApi, toIsoDate(nextMonday));
      expect(first?.invoice_count).toBe(1);
      expect(first?.total).toBeCloseTo(10, 2);
      expect(second?.invoice_count).toBe(1);
      expect(second?.total).toBeCloseTo(20, 2);
    });

    test("a factuur without a factuurdatum is excluded from every week", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const created = await postFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueFactuur("TEST-REV-NODATE"), totaal: 77.77 });
      expect(created.factuurdatum).toBeNull();

      const [weeksRes, facturenRes] = await Promise.all([ownerApi.get(PATH), ownerApi.get("/api/facturen")]);
      const weeks: any[] = await weeksRes.json();
      const facturen: any[] = await facturenRes.json();
      const counted = weeks.reduce((sum, w) => sum + w.invoice_count, 0);
      expect(counted).toBe(facturen.filter((f) => f.factuurdatum !== null).length);
    });

    test("re-POSTing the exact same factuur does not double-count its revenue (upsert)", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const payload = { factuur: uniqueFactuur("TEST-REV-DUP"), totaal: 33.3, factuurdatum: toIsoDate(monday) };

      const first = await postFactuur(baseUrl, apiKeyHeaders, payload);
      const second = await postFactuur(baseUrl, apiKeyHeaders, payload);
      expect(second.id).toBe(first.id);

      const row = await weekRow(ownerApi, toIsoDate(monday));
      expect(row?.invoice_count).toBe(1);
      expect(row?.total).toBeCloseTo(33.3, 2);
    });

    test("the same factuur with a different totaal is counted as a separate invoice", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const factuur = uniqueFactuur("TEST-REV-DISCREPANCY");
      // Upsert is on (factuur, totaal): a differing amount is a discrepancy kept as its own row.
      await postFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 40, factuurdatum: toIsoDate(monday) });
      await postFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 45, factuurdatum: toIsoDate(monday) });

      const row = await weekRow(ownerApi, toIsoDate(monday));
      expect(row?.invoice_count).toBe(2);
      expect(row?.total).toBeCloseTo(85, 2);
    });
  });
});
