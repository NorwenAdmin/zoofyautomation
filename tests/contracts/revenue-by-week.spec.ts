import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

const PATH = "/api/facturen/revenue-by-week";

async function revenueOperation(baseUrl: string) {
  const contract = await loadContract(baseUrl);
  const op = operationsForPrefix(contract, "/api/facturen").find((o) => o.path === PATH && o.method === "get");
  return { contract, op };
}

type Bucket = { week_number: number; week_start: string; week_end: string; total: number; invoice_count: number };

// Dates are "YYYY-MM-DD"; all arithmetic is done in UTC so the runner's timezone can't shift a day.
function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

// Postgres date_trunc('week', ...) truncates to the ISO week's Monday.
function mondayOf(iso: string): string {
  const dow = parseDate(iso).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((dow + 6) % 7));
}

function isoWeekNumber(iso: string): number {
  const d = parseDate(iso);
  // The ISO week belongs to the year containing its Thursday.
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

function assertBucketInvariants(buckets: Bucket[]) {
  for (const [i, b] of buckets.entries()) {
    expect(mondayOf(b.week_start), `week_start ${b.week_start} at index ${i} must be a Monday`).toBe(b.week_start);
    expect(b.week_end, `week_end at index ${i} must be week_start + 6 days`).toBe(addDays(b.week_start, 6));
    expect(b.week_number, `week_number at index ${i} must be the ISO week of ${b.week_start}`).toBe(
      isoWeekNumber(b.week_start)
    );
    // A bucket only exists because at least one dated factuur fell into it.
    expect(b.invoice_count).toBeGreaterThanOrEqual(1);
    if (i > 0) {
      // Most recent week first; ISO dates compare lexicographically, and strict > means no week repeats.
      expect(buckets[i - 1].week_start > b.week_start, `weeks must be strictly descending at index ${i}`).toBe(true);
    }
  }
}

test.describe(`Contract: ${PATH}`, () => {
  test("contract defines GET returning a RevenueByWeekOut list", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await revenueOperation(baseUrl);
    expect(op, `contract must define GET ${PATH}`).toBeTruthy();

    const schema = op!.operation.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(schema?.type).toBe("array");
    expect(responseSchemaName(op!.operation, "200")).toBe("RevenueByWeekOut");
    expect(op!.operation.requestBody, "a GET aggregate takes no body").toBeUndefined();
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
    // The list is one row per week, so it stays small — validate every row, not just the first.
    if (schemaName) {
      for (const row of body) assertMatchesSchema(contract, schemaName, row);
    }
    assertBucketInvariants(body);
  });

  test("GET buckets agree with the dated rows in GET /api/facturen", async ({ ownerApi }) => {
    // Read-only, so it runs on live too. Other spec files may POST facturen on another worker
    // between the two reads, so retry until both snapshots were taken from a stable table.
    await expect(async () => {
      const facturenBefore = await (await ownerApi.get("/api/facturen")).json();
      const buckets: Bucket[] = await (await ownerApi.get(PATH)).json();
      const facturenAfter = await (await ownerApi.get("/api/facturen")).json();
      expect(facturenAfter.length, "facturen changed mid-read, retrying").toBe(facturenBefore.length);

      const expected = new Map<string, { total: number; count: number }>();
      for (const f of facturenAfter) {
        if (!f.factuurdatum) continue; // undated rows can't be placed in a week and are excluded
        const key = mondayOf(f.factuurdatum);
        const agg = expected.get(key) ?? { total: 0, count: 0 };
        agg.total += f.totaal ?? 0;
        agg.count += 1;
        expected.set(key, agg);
      }

      expect(buckets.map((b) => b.week_start).sort()).toEqual([...expected.keys()].sort());
      for (const b of buckets) {
        const agg = expected.get(b.week_start)!;
        expect(b.invoice_count, `invoice_count for week ${b.week_start}`).toBe(agg.count);
        expect(b.total, `total for week ${b.week_start}`).toBeCloseTo(agg.total, 2);
      }
    }).toPass({ timeout: 15_000 });
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`);
    expect(res.status).toBe(401);
  });

  test("GET with a forged session cookie is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`, { headers: { Cookie: "session=not-a-real-signed-session" } });
    expect(res.status).toBe(401);
  });

  test("GET with only an X-API-Key (no session) is rejected", async ({}, testInfo) => {
    // The machine key authorizes n8n's writes, not the owner's revenue view.
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}`, { headers: { "X-API-Key": "not-a-real-key" } });
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    // No other spec posts a factuurdatum, but to stay independent of whatever is already in the
    // shared mock database, each test uses its own Monday in the 1900s and asserts on deltas.
    let nextWeekOffset = Math.floor(Date.now() / 1000) % 4000;
    function uniqueMonday(): string {
      return addDays("1900-01-01", 7 * nextWeekOffset++); // 1900-01-01 was a Monday
    }

    function postFactuur(baseUrl: string, headers: Record<string, string>, payload: Record<string, unknown>) {
      return fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          factuur: `TEST-REV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...payload,
        }),
      });
    }

    async function bucketFor(ownerApi: any, weekStart: string): Promise<Bucket | undefined> {
      const res = await ownerApi.get(PATH);
      expect(res.status()).toBe(200);
      const body: Bucket[] = await res.json();
      return body.find((b) => b.week_start === weekStart);
    }

    test("facturen dated Monday and Sunday of one week aggregate into a single bucket", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await revenueOperation(baseUrl);
      const monday = uniqueMonday();
      const sunday = addDays(monday, 6);

      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuurdatum: monday, totaal: 10.1 })).status).toBe(200);
      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuurdatum: sunday, totaal: 20.2 })).status).toBe(200);

      const bucket = await bucketFor(ownerApi, monday);
      expect(bucket, `a bucket for the week of ${monday} must exist`).toBeTruthy();
      expect(bucket!.week_end).toBe(sunday);
      expect(bucket!.week_number).toBe(isoWeekNumber(monday));
      expect(bucket!.invoice_count).toBe(2);
      // Numeric(10,2) is summed exactly in Postgres, then coerced to a JSON number (not a string).
      expect(typeof bucket!.total).toBe("number");
      expect(bucket!.total).toBeCloseTo(30.3, 2);

      const schemaName = responseSchemaName(op!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, bucket);
    });

    test("a factuur dated the following Monday starts a new bucket", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const nextMonday = addDays(monday, 7);
      nextWeekOffset++; // nextMonday is consumed too

      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuurdatum: addDays(monday, 6), totaal: 5 })).status).toBe(200);
      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuurdatum: nextMonday, totaal: 7 })).status).toBe(200);

      const first = await bucketFor(ownerApi, monday);
      const second = await bucketFor(ownerApi, nextMonday);
      expect(first?.invoice_count).toBe(1);
      expect(first?.total).toBeCloseTo(5, 2);
      expect(second?.invoice_count).toBe(1);
      expect(second?.total).toBeCloseTo(7, 2);
    });

    test("a factuur without a factuurdatum is excluded from every bucket", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = `TEST-REV-NODATE-${Date.now()}`;
      const created = await postFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 999.99 });
      expect(created.status).toBe(200);
      expect((await created.json()).factuurdatum).toBeNull();

      // The response carries no row ids, so the proof is that the endpoint still reconciles with
      // the dated rows of /api/facturen — the "agree with GET /api/facturen" test above, repeated
      // here right after inserting an undated row.
      await expect(async () => {
        const facturen = await (await ownerApi.get("/api/facturen")).json();
        const buckets: Bucket[] = await (await ownerApi.get(PATH)).json();
        const facturenAfter = await (await ownerApi.get("/api/facturen")).json();
        expect(facturenAfter.length).toBe(facturen.length);
        expect(facturen.some((f: any) => f.factuur === factuur)).toBe(true);
        const datedCount = facturen.filter((f: any) => f.factuurdatum).length;
        expect(buckets.reduce((n, b) => n + b.invoice_count, 0)).toBe(datedCount);
      }).toPass({ timeout: 15_000 });
    });

    test("a dated factuur with no totaal is counted but adds nothing to the total", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      // Paired with a priced row so the week's SUM is not all-NULL.
      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuurdatum: monday, totaal: 12.5 })).status).toBe(200);
      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuurdatum: addDays(monday, 2) })).status).toBe(200);

      const bucket = await bucketFor(ownerApi, monday);
      expect(bucket?.invoice_count).toBe(2);
      expect(bucket?.total).toBeCloseTo(12.5, 2);
    });

    test("re-POSTing the same factuur+totaal does not double-count revenue (upsert)", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const payload = { factuur: `TEST-REV-DUP-${Date.now()}`, factuurdatum: addDays(monday, 3), totaal: 40 };

      const first = await postFactuur(baseUrl, apiKeyHeaders, payload);
      const second = await postFactuur(baseUrl, apiKeyHeaders, payload);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await second.json()).id).toBe((await first.json()).id);

      const bucket = await bucketFor(ownerApi, monday);
      expect(bucket?.invoice_count).toBe(1);
      expect(bucket?.total).toBeCloseTo(40, 2);
    });

    test("the same factuur with a different totaal is counted as a separate row", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      // uq_facturen_factuur_totaal is on (factuur, totaal): a changed amount is a Zoofy
      // correction kept as its own row, so both amounts land in the week's revenue.
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      const factuur = `TEST-REV-CORR-${Date.now()}`;

      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuur, factuurdatum: monday, totaal: 40 })).status).toBe(200);
      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuur, factuurdatum: monday, totaal: 45 })).status).toBe(200);

      const bucket = await bucketFor(ownerApi, monday);
      expect(bucket?.invoice_count).toBe(2);
      expect(bucket?.total).toBeCloseTo(85, 2);
    });

    test("POST with a malformed factuurdatum is rejected with 422 and creates no bucket", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const monday = uniqueMonday();
      // Month 13 of the bucket's year — nothing may be guessed from it.
      const res = await postFactuur(baseUrl, apiKeyHeaders, { factuurdatum: `${monday.slice(0, 4)}-13-${monday.slice(8)}`, totaal: 1 });
      expect(res.status).toBe(422);
      expect(await bucketFor(ownerApi, monday)).toBeUndefined();
    });
  });
});
