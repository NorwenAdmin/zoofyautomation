import { test, expect } from "../fixtures/auth.js";
import { baseUrlFor } from "../env.js";

test.describe("Security", () => {
  test(
    "invalid X-API-Key is rejected on every mutating endpoint",
    { tag: "@security" },
    async ({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating checks are mock-only (US-3)");
      const baseUrl = baseUrlFor(testInfo.project.name);
      const endpoints: Array<{ method: string; path: string; body: unknown }> = [
        { method: "POST", path: "/api/subscriptions", body: { factuur: "X", kenmerk: "k" } },
        { method: "POST", path: "/api/appointments", body: { klusnummer: "X" } },
        { method: "POST", path: "/api/facturen", body: { factuur: "X", totaal: 1 } },
        { method: "POST", path: "/api/bookkeeping-entries", body: { kees_id: 1 } },
      ];
      for (const { method, path, body } of endpoints) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { "Content-Type": "application/json", "X-API-Key": "not-a-real-key" },
          body: JSON.stringify(body),
        });
        expect(res.status, `${method} ${path} with an invalid key`).toBe(401);
      }
    }
  );

  test.describe("injection attempts (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating checks are mock-only (US-3)");
    });

    test(
      "SQL-injection-shaped strings in a body field are stored safely, not executed",
      { tag: "@security" },
      async ({ apiKeyHeaders, ownerApi }, testInfo) => {
        const baseUrl = baseUrlFor(testInfo.project.name);
        const payload = {
          factuur: `INJ-${Date.now()}`,
          kenmerk: "1'; DROP TABLE subscription_invoices; --",
        };
        const res = await fetch(`${baseUrl}/api/subscriptions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        // Stored verbatim as a plain string — parameterized queries never interpret it as SQL.
        expect(body.kenmerk).toBe(payload.kenmerk);

        // The real proof an injection didn't land: the table still exists and is queryable.
        const listRes = await ownerApi.get("/api/subscriptions");
        expect(listRes.status()).toBe(200);
      }
    );

    test(
      "an injection-shaped path parameter on a typed integer id is rejected with 422, not 500",
      { tag: "@security" },
      async ({ apiKeyHeaders }, testInfo) => {
        const baseUrl = baseUrlFor(testInfo.project.name);
        const res = await fetch(`${baseUrl}/api/facturen/${encodeURIComponent("1; DROP TABLE facturen;--")}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify({ klusnummer: "x" }),
        });
        expect(res.status).toBe(422);
      }
    );

    test(
      "script-tag-shaped strings in a body field are stored verbatim, not executed",
      { tag: "@security" },
      async ({ apiKeyHeaders }, testInfo) => {
        const baseUrl = baseUrlFor(testInfo.project.name);
        const payload = { klusnummer: `XSS-${Date.now()}`, klus: "<script>alert(1)</script>" };
        const res = await fetch(`${baseUrl}/api/appointments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.klus).toBe(payload.klus);
      }
    );

    // Bookkeeping entries carry free text straight from Kees de Boekhouder's API
    // (description, customer_name, invoice_number) — text Zoofy never typed and can't vet.
    test(
      "SQL-injection-shaped strings in a bookkeeping entry are stored safely, not executed",
      { tag: "@security" },
      async ({ apiKeyHeaders, ownerApi }, testInfo) => {
        const baseUrl = baseUrlFor(testInfo.project.name);
        const payload = {
          kees_id: Number(`${Date.now()}`.slice(-8)) * 10 + Math.floor(Math.random() * 10),
          description: "1'; DROP TABLE bookkeeping_entries; --",
          customer_name: "Robert'); DROP TABLE facturen;--",
        };
        const res = await fetch(`${baseUrl}/api/bookkeeping-entries`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        // Stored verbatim as plain strings — parameterized queries never interpret them as SQL.
        expect(body.description).toBe(payload.description);
        expect(body.customer_name).toBe(payload.customer_name);

        // The real proof nothing landed: both tables the payload named are still queryable,
        // including through the Compare endpoint that reads them together.
        expect((await ownerApi.get("/api/bookkeeping-entries")).status()).toBe(200);
        expect((await ownerApi.get("/api/facturen")).status()).toBe(200);
        expect((await ownerApi.get("/api/bookkeeping/compare")).status()).toBe(200);
      }
    );

    test(
      "script-tag-shaped strings in a bookkeeping entry are stored verbatim, not executed",
      { tag: "@security" },
      async ({ apiKeyHeaders }, testInfo) => {
        const baseUrl = baseUrlFor(testInfo.project.name);
        const payload = {
          kees_id: Number(`${Date.now()}`.slice(-8)) * 10 + Math.floor(Math.random() * 10),
          invoice_number: `XSS-${Date.now()}`,
          description: "<script>alert(1)</script>",
          customer_name: "<img src=x onerror=alert(1)>",
        };
        const res = await fetch(`${baseUrl}/api/bookkeeping-entries`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiKeyHeaders },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.description).toBe(payload.description);
        expect(body.customer_name).toBe(payload.customer_name);
      }
    );
  });
});
