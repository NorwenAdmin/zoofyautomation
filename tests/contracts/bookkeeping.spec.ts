import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

const ENTRIES_PATH = "/api/bookkeeping-entries";
const COMPARE_PATH = "/api/bookkeeping/compare";

// kees_id (Kees de Boekhouder's own numeric invoice id) is the dedup key, and the mock stack's
// Postgres is shared by every spec in a run — so each test mints an id no other test uses.
let nextKeesId = Date.now() % 1_000_000_000;
function uniqueKeesId(): number {
  return nextKeesId++;
}

function uniqueRef(prefix: string): string {
  return `${prefix}-${uniqueKeesId()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function bookkeepingOperation(baseUrl: string, path: string, method: string) {
  const contract = await loadContract(baseUrl);
  const op = operationsForPrefix(contract, "/api/bookkeeping").find(
    (o) => o.path === path && o.method === method
  );
  return { contract, op };
}

function postEntry(baseUrl: string, headers: Record<string, string>, payload: unknown) {
  return fetch(`${baseUrl}${ENTRIES_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function postFactuur(baseUrl: string, headers: Record<string, string>, payload: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/facturen`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ totaal: 42.5, ...payload }),
  });
}

// Both bookkeeping lists come back ordered by date descending with NULL dates last. Other specs
// write to the same mock database, so the assertion is the ordering invariant over whatever the
// list happens to contain rather than an expected sequence of rows.
function assertSortedByDateDescNullsLast(values: Array<string | null>, label: string) {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const current = values[i];
    if (current === null) continue; // nulls are allowed to run to the end
    expect(prev, `${label}: dated row at index ${i} must not follow a null-dated row`).not.toBeNull();
    // Dates are ISO "YYYY-MM-DD", so lexicographic order is chronological order.
    expect(prev! >= current!, `${label}: ${prev} at index ${i - 1} must not sort after ${current}`).toBe(true);
  }
}

test.describe(`Contract: ${ENTRIES_PATH}`, () => {
  test("contract defines GET and POST with the BookkeepingEntry shapes", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op: getOp } = await bookkeepingOperation(baseUrl, ENTRIES_PATH, "get");
    const { op: postOp } = await bookkeepingOperation(baseUrl, ENTRIES_PATH, "post");
    expect(getOp, `contract must define GET ${ENTRIES_PATH}`).toBeTruthy();
    expect(postOp, `contract must define POST ${ENTRIES_PATH}`).toBeTruthy();

    expect(responseSchemaName(getOp!.operation, "200")).toBe("BookkeepingEntryOut");

    const requestRef = postOp!.operation.requestBody?.content?.["application/json"]?.schema?.$ref;
    expect(requestRef).toBe("#/components/schemas/BookkeepingEntryIn");
    expect(postOp!.operation.requestBody?.required).toBe(true);
    expect(responseSchemaName(postOp!.operation, "200")).toBe("BookkeepingEntryOut");
    expect(postOp!.operation.responses?.["422"], "validation errors must be documented").toBeTruthy();
  });

  test("GET returns a list matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { contract, op } = await bookkeepingOperation(baseUrl, ENTRIES_PATH, "get");
    expect(op, `contract must define GET ${ENTRIES_PATH}`).toBeTruthy();

    const res = await ownerApi.get(ENTRIES_PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const schemaName = responseSchemaName(op!.operation, "200");
    if (schemaName && body.length > 0) {
      assertMatchesSchema(contract, schemaName, body[0]);
    }
  });

  test("GET returns entries ordered by invoice_date descending, nulls last", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await ownerApi.get(ENTRIES_PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    assertSortedByDateDescNullsLast(
      body.map((e: any) => e.invoice_date ?? null),
      `GET ${ENTRIES_PATH}`
    );
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

    test("POST creates an entry matching the contract schema", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await bookkeepingOperation(baseUrl, ENTRIES_PATH, "post");
      expect(op, `contract must define POST ${ENTRIES_PATH}`).toBeTruthy();

      const payload = {
        kees_id: uniqueKeesId(),
        invoice_number: uniqueRef("BK"),
        file_name: uniqueRef("BK-FILE"),
        description: "Reparatie kraan",
        customer_name: "Zoofy B.V.",
        amount_incl: 121.0,
        state: "paid",
        invoice_date: "2026-03-04",
        raw: { invoiceNr: "from-kees", nested: { keep: true } },
      };
      const res = await postEntry(baseUrl, apiKeyHeaders, payload);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.kees_id).toBe(payload.kees_id);
      expect(body.invoice_number).toBe(payload.invoice_number);
      expect(body.file_name).toBe(payload.file_name);
      expect(body.amount_incl).toBe(payload.amount_incl);
      expect(body.invoice_date).toBe(payload.invoice_date);
      // `raw` keeps Kees's full API response verbatim, nesting included.
      expect(body.raw).toEqual(payload.raw);

      const schemaName = responseSchemaName(op!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, body);
    });

    test("POST with only kees_id is accepted and leaves the rest null", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await bookkeepingOperation(baseUrl, ENTRIES_PATH, "post");

      const kees_id = uniqueKeesId();
      const res = await postEntry(baseUrl, apiKeyHeaders, { kees_id });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.kees_id).toBe(kees_id);
      expect(body.invoice_number).toBeNull();
      expect(body.amount_incl).toBeNull();
      expect(body.raw).toBeNull();

      const schemaName = responseSchemaName(op!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, body);
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

    test("POST missing kees_id is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, apiKeyHeaders, { invoice_number: "no kees_id" });
      expect(res.status).toBe(422);
    });

    test("POST with a non-numeric kees_id is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, apiKeyHeaders, { kees_id: "not-a-number" });
      expect(res.status).toBe(422);
    });

    test("POST with a malformed invoice_date is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await postEntry(baseUrl, apiKeyHeaders, {
        kees_id: uniqueKeesId(),
        invoice_date: "04-03-2026",
      });
      expect(res.status).toBe(422);
    });

    test("POSTing the same kees_id twice does not create a duplicate (upsert)", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const payload = { kees_id: uniqueKeesId(), invoice_number: uniqueRef("BK-DUP"), amount_incl: 9.99 };

      const first = await postEntry(baseUrl, apiKeyHeaders, payload);
      const second = await postEntry(baseUrl, apiKeyHeaders, payload);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(secondBody.id).toBe(firstBody.id);

      const list = await (await ownerApi.get(ENTRIES_PATH)).json();
      expect(list.filter((e: any) => e.kees_id === payload.kees_id)).toHaveLength(1);
    });

    test("re-POSTing a kees_id with changed fields keeps the stored row as it was", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      // The router upserts with ON CONFLICT DO NOTHING and then re-reads the existing row, so
      // an n8n retry carrying edited values must not overwrite what Kees's first sync stored.
      const kees_id = uniqueKeesId();
      const original = { kees_id, invoice_number: uniqueRef("BK-KEEP"), state: "open", amount_incl: 100.0 };
      const changed = { kees_id, invoice_number: uniqueRef("BK-CHANGED"), state: "paid", amount_incl: 250.0 };

      const first = await postEntry(baseUrl, apiKeyHeaders, original);
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      const second = await postEntry(baseUrl, apiKeyHeaders, changed);
      expect(second.status).toBe(200);
      const secondBody = await second.json();

      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.invoice_number).toBe(original.invoice_number);
      expect(secondBody.state).toBe(original.state);
      expect(secondBody.amount_incl).toBe(original.amount_incl);

      const list = await (await ownerApi.get(ENTRIES_PATH)).json();
      expect(list.filter((e: any) => e.kees_id === kees_id)).toHaveLength(1);
      expect(list.some((e: any) => e.invoice_number === changed.invoice_number)).toBe(false);
    });
  });
});

test.describe(`Contract: ${COMPARE_PATH}`, () => {
  test("contract defines GET returning BookkeepingCompareOut", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await bookkeepingOperation(baseUrl, COMPARE_PATH, "get");
    expect(op, `contract must define GET ${COMPARE_PATH}`).toBeTruthy();
    expect(responseSchemaName(op!.operation, "200")).toBe("BookkeepingCompareOut");
  });

  test("GET returns both sides matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { contract, op } = await bookkeepingOperation(baseUrl, COMPARE_PATH, "get");
    expect(op, `contract must define GET ${COMPARE_PATH}`).toBeTruthy();

    const res = await ownerApi.get(COMPARE_PATH);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.missing_in_bookkeeping)).toBe(true);
    expect(Array.isArray(body.missing_in_facturen)).toBe(true);

    const schemaName = responseSchemaName(op!.operation, "200");
    if (schemaName) assertMatchesSchema(contract, schemaName, body);
  });

  test("GET returns both sides sorted by date descending, nulls last", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await ownerApi.get(COMPARE_PATH);
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
    const res = await fetch(`${baseUrl}${COMPARE_PATH}`);
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    async function compare(ownerApi: any) {
      const res = await ownerApi.get(COMPARE_PATH);
      expect(res.status()).toBe(200);
      return res.json();
    }

    test("a factuur with no bookkeeping entry shows up in missing_in_bookkeeping", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = uniqueRef("CMP-ONLY-ZOOFY");
      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuur })).status).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(true);
    });

    test("a bookkeeping entry with no factuur shows up in missing_in_facturen", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const kees_id = uniqueKeesId();
      expect(
        (await postEntry(baseUrl, apiKeyHeaders, { kees_id, invoice_number: uniqueRef("CMP-ONLY-KEES") })).status
      ).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === kees_id)).toBe(true);
    });

    test("matching on factuur/invoice_number pairs both sides up", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = uniqueRef("CMP-NUM");
      const kees_id = uniqueKeesId();

      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuur })).status).toBe(200);
      expect((await postEntry(baseUrl, apiKeyHeaders, { kees_id, invoice_number: factuur })).status).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(false);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === kees_id)).toBe(false);
    });

    test("matching on factuur/file_name pairs both sides up", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      // Kees's invoice_number sometimes holds the Kenmerk value instead of the real invoice
      // number; file_name stays factuur-shaped even then, so it has to match on its own.
      const factuur = uniqueRef("CMP-FILE");
      const kees_id = uniqueKeesId();

      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuur })).status).toBe(200);
      expect(
        (
          await postEntry(baseUrl, apiKeyHeaders, {
            kees_id,
            invoice_number: uniqueRef("CMP-FILE-UNRELATED"),
            file_name: factuur,
          })
        ).status
      ).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(false);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === kees_id)).toBe(false);
    });

    test("matching on kenmerk/invoice_number pairs both sides up", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = uniqueRef("CMP-KENMERK-F");
      const kenmerk = uniqueRef("CMP-KENMERK-K");
      const kees_id = uniqueKeesId();

      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuur, kenmerk })).status).toBe(200);
      expect((await postEntry(baseUrl, apiKeyHeaders, { kees_id, invoice_number: kenmerk })).status).toBe(200);

      const body = await compare(ownerApi);
      expect(body.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(false);
      expect(body.missing_in_facturen.some((e: any) => e.kees_id === kees_id)).toBe(false);
    });

    test("an entry stops being reported as missing once the matching factuur arrives", async ({
      apiKeyHeaders,
      ownerApi,
    }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = uniqueRef("CMP-LATE");
      const kees_id = uniqueKeesId();

      expect((await postEntry(baseUrl, apiKeyHeaders, { kees_id, invoice_number: factuur })).status).toBe(200);
      const before = await compare(ownerApi);
      expect(before.missing_in_facturen.some((e: any) => e.kees_id === kees_id)).toBe(true);

      expect((await postFactuur(baseUrl, apiKeyHeaders, { factuur })).status).toBe(200);
      const after = await compare(ownerApi);
      expect(after.missing_in_facturen.some((e: any) => e.kees_id === kees_id)).toBe(false);
      expect(after.missing_in_bookkeeping.some((f: any) => f.factuur === factuur)).toBe(false);
    });
  });
});
