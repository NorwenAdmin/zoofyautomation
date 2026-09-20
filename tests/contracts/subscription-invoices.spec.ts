import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix, responseSchemaName } from "../helpers/contract.js";
import { assertMatchesSchema } from "../helpers/schema.js";
import { baseUrlFor } from "../env.js";

test.describe("Contract: /api/subscriptions", () => {
  test("GET returns a list matching the contract schema", async ({ ownerApi }, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const contract = await loadContract(baseUrl);
    const ops = operationsForPrefix(contract, "/api/subscriptions");
    const getOp = ops.find((o) => o.path === "/api/subscriptions" && o.method === "get");
    expect(getOp, "contract must define GET /api/subscriptions").toBeTruthy();

    const res = await ownerApi.get("/api/subscriptions");
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
    const res = await fetch(`${baseUrl}/api/subscriptions`);
    expect(res.status).toBe(401);
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    test("POST creates a subscription invoice matching the contract schema", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const contract = await loadContract(baseUrl);
      const ops = operationsForPrefix(contract, "/api/subscriptions");
      const postOp = ops.find((o) => o.path === "/api/subscriptions" && o.method === "post");
      expect(postOp, "contract must define POST /api/subscriptions").toBeTruthy();

      const factuur = `TEST-${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ factuur, kenmerk: "Test kenmerk", amount: 12.34 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.factuur).toBe(factuur);

      const schemaName = responseSchemaName(postOp!.operation, "200");
      if (schemaName) assertMatchesSchema(contract, schemaName, body);
    });

    test("POST without X-API-Key is rejected", async ({}, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}/api/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factuur: "NOPE", kenmerk: "x" }),
      });
      expect(res.status).toBe(401);
    });

    test("POST with an invalid X-API-Key is rejected", async ({}, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}/api/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "wrong-key" },
        body: JSON.stringify({ factuur: "NOPE", kenmerk: "x" }),
      });
      expect(res.status).toBe(401);
    });

    test("POST missing required field is rejected with 422", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const res = await fetch(`${baseUrl}/api/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify({ kenmerk: "missing factuur" }),
      });
      expect(res.status).toBe(422);
    });

    test("POSTing the same factuur twice does not create a duplicate (upsert)", async ({ apiKeyHeaders }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const factuur = `TEST-DUP-${Date.now()}`;
      const payload = { factuur, kenmerk: "Dup test", amount: 9.99 };

      const first = await fetch(`${baseUrl}/api/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify(payload),
      });
      const second = await fetch(`${baseUrl}/api/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeaders },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(secondBody.id).toBe(firstBody.id);
    });
  });
});
