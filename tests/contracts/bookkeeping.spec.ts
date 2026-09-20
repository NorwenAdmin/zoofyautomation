import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

// US-1: scenarios come from the target's own live /openapi.json, never a hardcoded list.
// `bookkeeping_entries` holds the accountant's side of the books (pulled from Exact Online by
// n8n); `/api/bookkeeping/compare` diffs it against `facturen` (Zoofy's own emails) to flag
// invoices the accountant hasn't entered yet.
const ENTRIES_PATH = "/api/bookkeeping-entries";
const COMPARE_PATH = "/api/bookkeeping/compare";

function uniqueExactId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe(`Contract: ${ENTRIES_PATH}`, () => {
  test("GET returns a list matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const contract = await loadContract(baseUrl);
    const ops = operationsForPrefix(contract, ENTRIES_PATH);
    const getOp = ops.find((o) => o.path === ENTRIES_PATH && o.method === "get");
    expect(getOp, `contract must define GET ${ENTRIES_PATH}`).toBeTruthy();

    const res = await ownerApi.get(ENTRIES_PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const schemaName = responseSchemaName(getOp!.operation, "200");
    if (schemaName && body.length > 0) {
      assertMatchesSchema(contract, schemaName, body[0]);
    }
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${ENTRIES_PATH}`);
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    test("POST creates a bookkeeping entry matching the contract schema", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const contract = await loadContract(baseUrl);
      const ops = operationsForPrefix(contract, ENTRIES_PATH);
      const postOp = ops.find((o) => o.path === ENTRIES_PATH && o.method === "post");
      expect(postOp, `contract must define POST ${ENTRIES_PATH}`).toBeTruthy();

      const exactId = uniqueExactId("TEST-EXACT");
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({
          exact_id: exactId,
          invoice_number: "INV-1001",
          kenmerk: "Test kenmerk",
          amount_incl: 121.0,
          invoice_date: "2026-01-15",
          financial_year: 2026,
          // Exact's full API response is kept verbatim — the real field shapes are only
          // confirmed once this is wired up, so `raw` is the fallback for anything unmapped.
          raw: { Description: "Zoofy klus", VATAmountFC: 21.0 },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exact_id).toBe(exactId);
      expect(body.invoice_number).toBe("INV-1001");
      expect(body.raw).toEqual({ Description: "Zoofy klus", VATAmountFC: 21.0 });

      const schemaName = responseSchemaName(postOp!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, body);
    });

    test("POST accepts an entry with only the required exact_id", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const contract = await loadContract(baseUrl);
      const postOp = operationsForPrefix(contract, ENTRIES_PATH).find(
        (o) => o.path === ENTRIES_PATH && o.method === "post"
      );

      // invoice_number and kenmerk are the two candidate match fields and it isn't confirmed
      // which one the accountant fills in — so an entry carrying neither must still be stored.
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ exact_id: uniqueExactId("TEST-MINIMAL") }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.invoice_number).toBeNull();
      expect(body.kenmerk).toBeNull();

      const schemaName = responseSchemaName(postOp!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, body);
    });

    test("POST without X-API-Key is rejected", async ({}, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exact_id: "NOPE" }),
      });
      expect(res.status).toBe(401);
    });

    test("POST with an invalid X-API-Key is rejected", async ({}, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "wrong-key" },
        body: JSON.stringify({ exact_id: "NOPE" }),
      });
      expect(res.status).toBe(401);
    });

    test("POST missing required exact_id is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ invoice_number: "INV-NO-ID", kenmerk: "missing exact_id" }),
      });
      expect(res.status).toBe(422);
    });

    test("POST with a wrongly typed field is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ exact_id: uniqueExactId("TEST-BADTYPE"), raw: "not-an-object" }),
      });
      expect(res.status).toBe(422);
    });

    test("POST with an invalid invoice_date is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ exact_id: uniqueExactId("TEST-BADDATE"), invoice_date: "15-01-2026" }),
      });
      expect(res.status).toBe(422);
    });

    test("POSTing the same exact_id twice does not create a duplicate (upsert)", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const exactId = uniqueExactId("TEST-DUP");
      const payload = { exact_id: exactId, invoice_number: "INV-DUP", kenmerk: "Dup test", amount_incl: 9.99 };

      const send = (body: unknown) =>
        fetch(`${baseUrl}${ENTRIES_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify(body),
        });

      const first = await send(payload);
      const second = await send(payload);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(secondBody.id).toBe(firstBody.id);

      const list = await (await ownerApi.get(ENTRIES_PATH)).json();
      expect(list.filter((e: any) => e.exact_id === exactId)).toHaveLength(1);
    });

    test("re-POSTing an exact_id returns the stored row unchanged (ON CONFLICT DO NOTHING)", async ({
      apiKeyHeaders,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const exactId = uniqueExactId("TEST-NOOVERWRITE");
      const send = (body: unknown) =>
        fetch(`${baseUrl}${ENTRIES_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify(body),
        });

      const first = await (await send({ exact_id: exactId, invoice_number: "INV-FIRST", amount_incl: 100.0 })).json();
      // A re-sync of the same Exact invoice must not flip already-stored values — the router
      // upserts DO NOTHING, so the first write wins and the existing row is returned as-is.
      const second = await (await send({ exact_id: exactId, invoice_number: "INV-SECOND", amount_incl: 200.0 })).json();

      expect(second.id).toBe(first.id);
      expect(second.invoice_number).toBe("INV-FIRST");
      expect(Number(second.amount_incl)).toBe(100.0);
    });
  });
});

test.describe(`Contract: ${COMPARE_PATH}`, () => {
  test("GET returns a diff matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const contract = await loadContract(baseUrl);
    const getOp = operationsForPrefix(contract, COMPARE_PATH).find(
      (o) => o.path === COMPARE_PATH && o.method === "get"
    );
    expect(getOp, `contract must define GET ${COMPARE_PATH}`).toBeTruthy();

    const res = await ownerApi.get(COMPARE_PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.missing_in_bookkeeping)).toBe(true);
    expect(Array.isArray(body.missing_in_facturen)).toBe(true);

    const schemaName = responseSchemaName(getOp!.operation, "200");
    expect(schemaName).toBe("BookkeepingCompareOut");
    assertMatchesSchema(contract, schemaName!, body);
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${COMPARE_PATH}`);
    expect(res.status).toBe(401);
  });

  // The diff is only observable after writing to both sides, so these need the mock stack even
  // though /api/bookkeeping/compare is itself a GET.
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

    async function createEntry(
      baseUrl: string,
      apiKeyHeaders: Record<string, string>,
      body: Record<string, unknown>
    ) {
      const res = await fetch(`${baseUrl}${ENTRIES_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify(body),
      });
      expect(res.status, `setup: POST ${ENTRIES_PATH} must succeed`).toBe(200);
      return res.json();
    }

    test("a factuur with no bookkeeping entry shows up in missing_in_bookkeeping", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuurNr = uniqueExactId("CMP-ORPHAN");
      await createFactuur(baseUrl, apiKeyHeaders, { factuur: factuurNr, totaal: 50.0 });

      const body = await (await ownerApi.get(COMPARE_PATH)).json();
      expect(body.missing_in_bookkeeping.map((f: any) => f.factuur)).toContain(factuurNr);
    });

    test("a bookkeeping entry with no factuur shows up in missing_in_facturen", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const exactId = uniqueExactId("CMP-UNMATCHED");
      await createEntry(baseUrl, apiKeyHeaders, { exact_id: exactId, invoice_number: uniqueExactId("CMP-NOFAC") });

      const body = await (await ownerApi.get(COMPARE_PATH)).json();
      expect(body.missing_in_facturen.map((e: any) => e.exact_id)).toContain(exactId);
    });

    test("matching on invoice_number takes a factuur out of the diff", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuurNr = uniqueExactId("CMP-BYNUMBER");
      const exactId = uniqueExactId("CMP-BYNUMBER-EXACT");
      await createFactuur(baseUrl, apiKeyHeaders, { factuur: factuurNr, totaal: 75.0 });
      await createEntry(baseUrl, apiKeyHeaders, { exact_id: exactId, invoice_number: factuurNr });

      const body = await (await ownerApi.get(COMPARE_PATH)).json();
      expect(body.missing_in_bookkeeping.map((f: any) => f.factuur)).not.toContain(factuurNr);
      expect(body.missing_in_facturen.map((e: any) => e.exact_id)).not.toContain(exactId);
    });

    test("matching on kenmerk alone also takes a factuur out of the diff", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      // It isn't confirmed yet which field the accountant keys invoices in by, so kenmerk is a
      // match on its own even when the invoice numbers don't line up at all.
      const kenmerk = uniqueExactId("CMP-KENMERK");
      const factuurNr = uniqueExactId("CMP-BYKENMERK-FAC");
      const exactId = uniqueExactId("CMP-BYKENMERK-EXACT");
      await createFactuur(baseUrl, apiKeyHeaders, { factuur: factuurNr, totaal: 80.0, kenmerk });
      await createEntry(baseUrl, apiKeyHeaders, {
        exact_id: exactId,
        invoice_number: uniqueExactId("CMP-DIFFERENT-NUMBER"),
        kenmerk,
      });

      const body = await (await ownerApi.get(COMPARE_PATH)).json();
      expect(body.missing_in_bookkeeping.map((f: any) => f.factuur)).not.toContain(factuurNr);
      expect(body.missing_in_facturen.map((e: any) => e.exact_id)).not.toContain(exactId);
    });

    test("the diff entries themselves match the contract schemas", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const contract = await loadContract(baseUrl);
      await createFactuur(baseUrl, apiKeyHeaders, { factuur: uniqueExactId("CMP-SHAPE-FAC"), totaal: 12.5 });
      await createEntry(baseUrl, apiKeyHeaders, { exact_id: uniqueExactId("CMP-SHAPE-EXACT") });

      const body = await (await ownerApi.get(COMPARE_PATH)).json();
      assertMatchesSchema(contract, "BookkeepingCompareOut", body);
      expect(body.missing_in_bookkeeping.length).toBeGreaterThan(0);
      expect(body.missing_in_facturen.length).toBeGreaterThan(0);
    });
  });
});
