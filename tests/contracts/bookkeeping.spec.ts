import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

// US-1: scenarios come from the target's own live /openapi.json, never a hardcoded list.
// `bookkeeping_entries` holds the accountant's (Kees de Boekhouder) side of the same invoices
// `facturen` holds Zoofy's side of, and /api/bookkeeping/compare diffs the two.

const ENTRIES = "/api/bookkeeping-entries";
const COMPARE = "/api/bookkeeping/compare";

function uniqueKeesId(): number {
  // kees_id is Kees's own numeric invoice id and the dedup key — these tests run against a
  // shared mock database, so every test needs one nobody else will pick. The column is a
  // plain INTEGER, so this has to stay under 2^31-1: 8 clock digits plus a random one.
  return Number(`${Date.now()}`.slice(-8)) * 10 + Math.floor(Math.random() * 10);
}

async function postEntry(baseUrl: string, headers: Record<string, string>, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${ENTRIES}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Both list endpoints order by date descending with NULLs last, so the frontend's two lists
// don't come back in arbitrary insertion order. Asserted on whatever rows the target has.
function assertSortedByDateDescNullsLast(dates: Array<string | null>, label: string): void {
  const firstNullIdx = dates.indexOf(null);
  if (firstNullIdx !== -1) {
    expect(dates.slice(firstNullIdx).every((d) => d === null), `${label}: NULL dates must sort last`).toBe(true);
  }
  const present = (firstNullIdx === -1 ? dates : dates.slice(0, firstNullIdx)) as string[];
  for (let i = 1; i < present.length; i++) {
    expect(present[i] <= present[i - 1], `${label}: ${present[i]} must not sort after ${present[i - 1]}`).toBe(true);
  }
}

test.describe(`Contract: ${ENTRIES}`, () => {
  test("GET returns a list matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const contract = await loadContract(baseUrl);
    const ops = operationsForPrefix(contract, ENTRIES);
    const getOp = ops.find((o) => o.path === ENTRIES && o.method === "get");
    expect(getOp, `contract must define GET ${ENTRIES}`).toBeTruthy();

    const res = await ownerApi.get(ENTRIES);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const schemaName = responseSchemaName(getOp!.operation, "200");
    if (schemaName && body.length > 0) {
      assertMatchesSchema(contract, schemaName, body[0]);
    }
  });

  test("GET returns entries newest first, undated ones last", async ({ ownerApi }) => {
    const res = await ownerApi.get(ENTRIES);
    expect(res.status()).toBe(200);
    const body = await res.json();
    assertSortedByDateDescNullsLast(
      body.map((e: any) => e.invoice_date ?? null),
      `GET ${ENTRIES}`
    );
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${ENTRIES}`);
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    test("POST creates a bookkeeping entry matching the contract schema", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const contract = await loadContract(baseUrl);
      const ops = operationsForPrefix(contract, ENTRIES);
      const postOp = ops.find((o) => o.path === ENTRIES && o.method === "post");
      expect(postOp, `contract must define POST ${ENTRIES}`).toBeTruthy();

      const keesId = uniqueKeesId();
      const payload = {
        kees_id: keesId,
        invoice_number: `KEES-${keesId}`,
        file_name: `KEES-${keesId}.pdf`,
        description: "Reparatie kraan",
        customer_name: "Testklant BV",
        amount_incl: 121.0,
        state: "paid",
        invoice_date: "2026-01-15",
        raw: { invoiceNr: `KEES-${keesId}`, anything: "else" },
      };
      const res = await postEntry(baseUrl, apiKeyHeaders, payload);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kees_id).toBe(keesId);
      expect(body.invoice_number).toBe(payload.invoice_number);
      // `raw` keeps Kees's full API response for anything not otherwise mapped.
      expect(body.raw).toEqual(payload.raw);

      const schemaName = responseSchemaName(postOp!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, body);
    });

    test("POST accepts an entry with only kees_id — every other field is optional", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const contract = await loadContract(baseUrl);
      const keesId = uniqueKeesId();

      const res = await postEntry(baseUrl, apiKeyHeaders, { kees_id: keesId });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kees_id).toBe(keesId);
      expect(body.invoice_number).toBeNull();
      assertMatchesSchema(contract, "BookkeepingEntryOut", body);
    });

    test("POST without X-API-Key is rejected", async ({}, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, {}, { kees_id: uniqueKeesId() });
      expect(res.status).toBe(401);
    });

    test("POST with an invalid X-API-Key is rejected", async ({}, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, { "X-API-Key": "wrong-key" }, { kees_id: uniqueKeesId() });
      expect(res.status).toBe(401);
    });

    test("POST missing the required kees_id is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, apiKeyHeaders, { invoice_number: "KEES-NO-ID" });
      expect(res.status).toBe(422);
    });

    test("POST with a non-integer kees_id is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, apiKeyHeaders, { kees_id: "not-a-number" });
      expect(res.status).toBe(422);
    });

    test("POST with a malformed invoice_date is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, apiKeyHeaders, { kees_id: uniqueKeesId(), invoice_date: "15-01-2026" });
      expect(res.status).toBe(422);
    });

    test("POSTing the same kees_id twice does not create a duplicate (upsert)", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const keesId = uniqueKeesId();
      const payload = { kees_id: keesId, invoice_number: `KEES-DUP-${keesId}`, amount_incl: 99.99 };

      const first = await postEntry(baseUrl, apiKeyHeaders, payload);
      const second = await postEntry(baseUrl, apiKeyHeaders, payload);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(secondBody.id).toBe(firstBody.id);

      const list = await (await ownerApi.get(ENTRIES)).json();
      expect(list.filter((e: any) => e.kees_id === keesId)).toHaveLength(1);
    });

    test("re-POSTing an existing kees_id returns the stored row unchanged (ON CONFLICT DO NOTHING)", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const keesId = uniqueKeesId();

      const first = await postEntry(baseUrl, apiKeyHeaders, {
        kees_id: keesId,
        invoice_number: `KEES-KEEP-${keesId}`,
        state: "open",
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      // The router upserts with DO NOTHING and then re-reads the existing row, so a retry that
      // carries different values must NOT overwrite what is already stored — first write wins.
      const second = await postEntry(baseUrl, apiKeyHeaders, {
        kees_id: keesId,
        invoice_number: "KEES-OVERWRITTEN",
        state: "paid",
      });
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.invoice_number).toBe(`KEES-KEEP-${keesId}`);
      expect(secondBody.state).toBe("open");
    });
  });
});

test.describe(`Contract: ${COMPARE}`, () => {
  test("GET returns both diff lists matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const contract = await loadContract(baseUrl);
    const getOp = operationsForPrefix(contract, COMPARE).find((o) => o.path === COMPARE && o.method === "get");
    expect(getOp, `contract must define GET ${COMPARE}`).toBeTruthy();

    const res = await ownerApi.get(COMPARE);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.missing_in_bookkeeping)).toBe(true);
    expect(Array.isArray(body.missing_in_facturen)).toBe(true);

    const schemaName = responseSchemaName(getOp!.operation, "200");
    expect(schemaName).toBe("BookkeepingCompareOut");
    assertMatchesSchema(contract, schemaName!, body);
  });

  test("GET returns both sides newest first, undated ones last", async ({ ownerApi }) => {
    const res = await ownerApi.get(COMPARE);
    expect(res.status()).toBe(200);
    const body = await res.json();
    assertSortedByDateDescNullsLast(
      body.missing_in_bookkeeping.map((f: any) => f.factuurdatum ?? null),
      "missing_in_bookkeeping"
    );
    assertSortedByDateDescNullsLast(
      body.missing_in_facturen.map((e: any) => e.invoice_date ?? null),
      "missing_in_facturen"
    );
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${COMPARE}`);
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    async function createFactuur(
      baseUrl: string,
      apiKeyHeaders: Record<string, string>,
      body: Record<string, unknown>
    ) {
      const res = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify(body),
      });
      expect(res.status, "setup: POST /api/facturen must succeed").toBe(200);
      return res.json();
    }

    async function compare(ownerApi: { get: (p: string) => Promise<any> }) {
      const res = await ownerApi.get(COMPARE);
      expect(res.status()).toBe(200);
      return res.json();
    }

    test("a factuur with no matching bookkeeping entry shows up as missing_in_bookkeeping", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = `CMP-ONLY-ZOOFY-${Date.now()}`;
      await createFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 50.0, factuurdatum: "2026-02-01" });

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(true);
    });

    test("a bookkeeping entry with no matching factuur shows up as missing_in_facturen", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const keesId = uniqueKeesId();
      const res = await postEntry(baseUrl, apiKeyHeaders, {
        kees_id: keesId,
        invoice_number: `CMP-ONLY-KEES-${keesId}`,
        invoice_date: "2026-02-02",
      });
      expect(res.status).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === keesId)).toBe(true);
    });

    test("a pair matching on factuur/invoice_number is absent from both lists", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = `CMP-NR-${Date.now()}`;
      const keesId = uniqueKeesId();
      await createFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 60.0 });
      expect((await postEntry(baseUrl, apiKeyHeaders, { kees_id: keesId, invoice_number: factuur })).status).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(false);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === keesId)).toBe(false);
    });

    test("a pair matching on factuur/file_name is absent from both lists", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      // Kees's invoiceNr sometimes holds the Kenmerk value instead of the real invoice number,
      // but file_name (his PDF filename, minus .pdf) stays factuur-shaped — so it must match too.
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = `CMP-FILE-${Date.now()}`;
      const keesId = uniqueKeesId();
      await createFactuur(baseUrl, apiKeyHeaders, { factuur, totaal: 70.0 });
      const res = await postEntry(baseUrl, apiKeyHeaders, {
        kees_id: keesId,
        invoice_number: "KENMERK-INSTEAD-OF-NUMBER",
        file_name: factuur,
      });
      expect(res.status).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(false);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === keesId)).toBe(false);
    });

    test("a pair matching on kenmerk/invoice_number is absent from both lists", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const kenmerk = `CMP-KENMERK-${Date.now()}`;
      const factuur = `CMP-KM-FACTUUR-${Date.now()}`;
      const keesId = uniqueKeesId();
      await createFactuur(baseUrl, apiKeyHeaders, { factuur, kenmerk, totaal: 80.0 });
      expect((await postEntry(baseUrl, apiKeyHeaders, { kees_id: keesId, invoice_number: kenmerk })).status).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(false);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === keesId)).toBe(false);
    });
  });
});
