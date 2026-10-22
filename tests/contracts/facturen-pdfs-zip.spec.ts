import { test, expect } from "../fixtures/auth.js";
import { loadContract, operationsForPrefix } from "../helpers/contract.js";
import { baseUrlFor } from "../env.js";

// GET /api/facturen/pdfs.zip is the "Download selected" button on the Bookkeeping tab. Archive
// *contents* are covered at the database layer (backend/tests/test_pdf_zip.py, stdlib zipfile);
// this file covers what only the HTTP surface can show: the documented contract, who may call it,
// input validation, and the real bytes arriving as a zip.
const PATH = "/api/facturen/pdfs.zip";

// Reads entry names out of a zip's central directory (signature 0x02014b50). Enough to prove which
// files are in the archive without pulling in a zip library as a dev dependency.
function zipEntryNames(bytes: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i <= bytes.length - 46; i++) {
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(i + 28);
    const extraLength = bytes.readUInt16LE(i + 30);
    const commentLength = bytes.readUInt16LE(i + 32);
    names.push(bytes.toString("utf8", i + 46, i + 46 + nameLength));
    i += 45 + nameLength + extraLength + commentLength;
  }
  return names;
}

test.describe(`Contract: ${PATH}`, () => {
  test("contract defines GET with a required `ids` array query parameter returning application/zip", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const contract = await loadContract(baseUrl);
    const op = operationsForPrefix(contract, "/api/facturen").find((o) => o.path === PATH && o.method === "get");
    expect(op, `contract must define GET ${PATH}`).toBeTruthy();

    const ids = op!.operation.parameters?.find((p: any) => p.name === "ids" && p.in === "query");
    expect(ids, "an `ids` query parameter").toBeTruthy();
    expect(ids.required).toBe(true);
    expect(ids.schema.type).toBe("array");
    expect(ids.schema.items.type).toBe("integer");
    expect(ids.schema.minItems).toBe(1);
    expect(ids.schema.maxItems, "the request size is bounded").toBeGreaterThan(0);

    const zip = op!.operation.responses?.["200"]?.content?.["application/zip"];
    expect(zip, "200 documents an application/zip body").toBeTruthy();
    expect(zip.schema).toEqual({ type: "string", format: "binary" });
    expect(Object.keys(op!.operation.responses)).toEqual(expect.arrayContaining(["403", "404"]));
  });

  test("GET without a session is rejected", async ({}, testInfo) => {
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}?ids=1`);
    expect(res.status).toBe(401);
  });

  test("GET with only an X-API-Key (no session) is rejected", async ({}, testInfo) => {
    // The machine key authorises n8n's writes, not downloading the owner's invoices.
    const baseUrl = baseUrlFor(testInfo.project.name);
    const res = await fetch(`${baseUrl}${PATH}?ids=1`, { headers: { "X-API-Key": "not-a-real-key" } });
    expect(res.status).toBe(401);
  });

  test("GET without ids, with a non-integer id, or with too many ids is rejected with 422", async ({ ownerApi }) => {
    expect((await ownerApi.get(PATH)).status(), "no ids").toBe(422);
    expect((await ownerApi.get(`${PATH}?ids=abc`)).status(), "non-integer id").toBe(422);
    const tooMany = Array.from({ length: 501 }, (_, i) => `ids=${i + 1}`).join("&");
    expect((await ownerApi.get(`${PATH}?${tooMany}`)).status(), "501 ids").toBe(422);
  });

  test("GET with an unknown id is 404 and returns no archive (read-only, runs on live too)", async ({ ownerApi }) => {
    const res = await ownerApi.get(`${PATH}?ids=999999999`);
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect((await res.json()).detail).toContain("999999999");
  });

  test.describe("mutations (mock only)", () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name === "live", "mutating tests only run against the mock stack (US-3)");
    });

    async function seedInvoice(baseUrl: string, headers: Record<string, string>, factuur: string, pdfText: string) {
      const created = await fetch(`${baseUrl}/api/facturen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ factuur, totaal: 12.5 }),
      });
      expect(created.status).toBe(200);
      const { id } = await created.json();

      const form = new FormData();
      form.append("file", new Blob([`%PDF-1.4 ${pdfText}`], { type: "application/pdf" }), "x.pdf");
      const uploaded = await fetch(`${baseUrl}/api/facturen/${id}/pdf`, { method: "POST", headers, body: form });
      expect(uploaded.status).toBe(200);
      return id as number;
    }

    test("the owner gets a real zip of exactly the requested invoices, named after their invoice numbers", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const stamp = Date.now();
      const first = await seedInvoice(baseUrl, apiKeyHeaders, `ZIP-A-${stamp}`, "first");
      const second = await seedInvoice(baseUrl, apiKeyHeaders, `ZIP-B-${stamp}`, "second");
      await seedInvoice(baseUrl, apiKeyHeaders, `ZIP-C-${stamp}`, "not requested");

      const res = await ownerApi.get(`${PATH}?ids=${first}&ids=${second}`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("application/zip");
      expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.zip"$/);
      expect(res.headers()["cache-control"]).toContain("no-store");

      const body = await res.body();
      expect(body.subarray(0, 4).toString("latin1"), "zip local-file-header signature").toBe("PK\u0003\u0004");
      expect(zipEntryNames(body).sort()).toEqual([`ZIP-A-${stamp}.pdf`, `ZIP-B-${stamp}.pdf`]);
    });

    test("one missing id fails the whole request, even when the other ids are fine", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const good = await seedInvoice(baseUrl, apiKeyHeaders, `ZIP-OK-${Date.now()}`, "fine");

      const res = await ownerApi.get(`${PATH}?ids=${good}&ids=999999999`);
      expect(res.status()).toBe(404);
      expect(res.headers()["content-type"]).toContain("application/json");
    });

    test("the demo account is refused, so the real files stay private", async ({ apiKeyHeaders, demoApi }, testInfo) => {
      const baseUrl = baseUrlFor(testInfo.project.name);
      const id = await seedInvoice(baseUrl, apiKeyHeaders, `ZIP-DEMO-${Date.now()}`, "private");

      const res = await demoApi.get(`${PATH}?ids=${id}`);
      expect(res.status()).toBe(403);
      expect(res.headers()["content-type"]).toContain("application/json");
    });
  });
});
