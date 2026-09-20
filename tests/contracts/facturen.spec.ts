import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

const PATH = "/api/facturen/{factuur_id}";

// US-1: scenarios are derived from the target's own live /openapi.json, never a hardcoded list.
// Unlike subscription-invoices.spec.ts (where both targets implement the endpoint and a missing
// operation is a hard failure), PATCH /api/facturen/{factuur_id} is a *drifted* endpoint: it
// exists on the deployed instance but not yet in the backend the mock stack is built from. So a
// target that doesn't expose it skips rather than fails — `npm run check-drift` is what reports
// the drift itself, and these tests start running against mock the moment the route lands.
async function patchOperation(baseUrl: string) {
  const contract = await loadContract(baseUrl);
  const op = operationsForPrefix(contract, "/api/facturen").find(
    (o) => o.path === PATH && o.method === "patch"
  );
  return { contract, op };
}

const NOT_IN_CONTRACT = `this target's /openapi.json does not define PATCH ${PATH} yet (see 'npm run check-drift')`;

test.describe(`Contract: ${PATH}`, () => {
  test("contract defines PATCH with the FactuurUpdateIn/FactuurOut shapes", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const { op } = await patchOperation(baseUrl);
    test.skip(!op, NOT_IN_CONTRACT);

    const params = op!.operation.parameters ?? [];
    const idParam = params.find((p: any) => p.in === "path" && p.name === "factuur_id");
    expect(idParam, "factuur_id must be a path parameter").toBeTruthy();
    expect(idParam.required).toBe(true);
    expect(idParam.schema?.type).toBe("integer");

    const requestRef = op!.operation.requestBody?.content?.["application/json"]?.schema?.$ref;
    expect(requestRef).toBe("#/components/schemas/FactuurUpdateIn");
    expect(op!.operation.requestBody?.required).toBe(true);

    expect(responseSchemaName(op!.operation, "200")).toBe("FactuurOut");
    expect(op!.operation.responses?.["422"], "validation errors must be documented").toBeTruthy();
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    // n8n creates the row from the parsed email first, then PATCHes it with the job details that
    // only exist in the PDF's text layer — so every mutation test starts from a real created row.
    async function createFactuur(
      baseUrl: string,
      apiKeyHeaders: Record<string, string>,
      overrides: Record<string, unknown> = {}
    ) {
      const res = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ factuur: `TEST-F-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, totaal: 42.5, ...overrides }),
      });
      expect(res.status, "setup: POST /api/facturen must succeed").toBe(200);
      return res.json();
    }

    test("PATCH fills in the PDF-derived job details and matches the contract schema", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { contract, op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const created = await createFactuur(baseUrl, apiKeyHeaders);
      const update = {
        klusnummer: "K-12345",
        klusomschrijving: "Vervangen thermostaatknop",
        klusadres: "Teststraat 1, Amsterdam",
      };

      const res = await fetch(`${baseUrl}/api/facturen/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify(update),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.id).toBe(created.id);
      expect(body.klusnummer).toBe(update.klusnummer);
      expect(body.klusomschrijving).toBe(update.klusomschrijving);
      expect(body.klusadres).toBe(update.klusadres);
      // The PATCH carries only PDF fields — the email-derived ones must survive it.
      expect(body.factuur).toBe(created.factuur);
      expect(body.totaal).toBe(created.totaal);

      const schemaName = responseSchemaName(op!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, body);
    });

    test("PATCH leaves fields that were not sent untouched", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const created = await createFactuur(baseUrl, apiKeyHeaders, {
        klusnummer: "K-KEEP",
        klusomschrijving: "Bestaande omschrijving",
      });

      const res = await fetch(`${baseUrl}/api/facturen/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ klusadres: "Alleen adres 2" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.klusadres).toBe("Alleen adres 2");
      expect(body.klusnummer).toBe("K-KEEP");
      expect(body.klusomschrijving).toBe("Bestaande omschrijving");
    });

    test("PATCHing twice updates in place instead of creating a second row", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const created = await createFactuur(baseUrl, apiKeyHeaders);
      const update = { klusnummer: "K-RETRY", klusomschrijving: "Retry van n8n", klusadres: "Herhaalstraat 3" };
      const send = () =>
        fetch(`${baseUrl}/api/facturen/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify(update),
        });

      const first = await send();
      const second = await send();
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.klusnummer).toBe(firstBody.klusnummer);

      const listRes = await ownerApi.get("/api/facturen");
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      expect(list.filter((f: any) => f.factuur === created.factuur)).toHaveLength(1);
    });

    test("PATCH without X-API-Key is rejected", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const created = await createFactuur(baseUrl, apiKeyHeaders);
      const res = await fetch(`${baseUrl}/api/facturen/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ klusnummer: "K-NOPE" }),
      });
      expect(res.status).toBe(401);
    });

    test("PATCH with an invalid X-API-Key is rejected", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const created = await createFactuur(baseUrl, apiKeyHeaders);
      const res = await fetch(`${baseUrl}/api/facturen/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": "wrong-key" },
        body: JSON.stringify({ klusnummer: "K-NOPE" }),
      });
      expect(res.status).toBe(401);
    });

    test("PATCH with a wrongly typed field is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const created = await createFactuur(baseUrl, apiKeyHeaders);
      const res = await fetch(`${baseUrl}/api/facturen/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ klusnummer: { not: "a string" } }),
      });
      expect(res.status).toBe(422);
    });

    test("PATCH with a non-integer factuur_id is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const res = await fetch(`${baseUrl}/api/facturen/not-a-number`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ klusnummer: "K-1" }),
      });
      expect(res.status).toBe(422);
    });

    test("PATCH on an unknown factuur_id is rejected instead of creating a row", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const { op } = await patchOperation(baseUrl);
      test.skip(!op, NOT_IN_CONTRACT);

      const before = await (await ownerApi.get("/api/facturen")).json();
      // 404 is what the sibling POST /api/facturen/{factuur_id}/pdf returns for a missing row;
      // the contract documents no 404, so the real assertion is "not 200, and nothing created".
      const res = await fetch(`${baseUrl}/api/facturen/999999999`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ klusnummer: "K-GHOST" }),
      });
      expect(res.status).toBe(404);

      const after = await (await ownerApi.get("/api/facturen")).json();
      expect(after).toHaveLength(before.length);
    });
  });
});
