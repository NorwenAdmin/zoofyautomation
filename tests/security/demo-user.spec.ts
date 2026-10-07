import { test, expect } from "../fixtures/auth.js";
import { baseUrlFor } from "../env.js";

// The demo account reads the owner's rows through an anonymiser (backend/app/demo.py): prices become
// 30-40 EUR, links become dummy URLs, addresses lose house numbers, the raw Kees payload is dropped.
// These tests plant recognisably "real" values through the real write API and prove none of them
// ever reach the demo user, on every endpoint that returns data. Mock-only: the demo account is
// created inside the throwaway stack by scripts/run-mock.sh and writes are mock-only (US-3).

const RUN = Date.now();
const REAL = {
  thread: `https://mail.google.com/mail/u/0/#inbox/REALTHREAD-${RUN}`,
  address: "Mortelstraat 117 1019VE Amsterdam",
  total: 987.65,
  keesAmount: 1234.56,
  rawSecret: `REALRAW-${RUN}`,
};
const FACTUUR = `DEMO-FAC-${RUN}`;
const SUBSCRIPTION = `DEMO-SUB-${RUN}`;
const APPOINTMENT = `DEMO-APT-${RUN}`;
const KEES_ID = 1_600_000_000 + (RUN % 99_000_000);
// A date no other spec uses, so the weekly bucket is easy to find.
const INVOICE_DATE = "1887-03-09";

const DUMMY_PREFIX = "https://example.com/demo/";

function inDemoRange(value: number | null) {
  if (value === null) return;
  expect(value).toBeGreaterThanOrEqual(30);
  expect(value).toBeLessThanOrEqual(40);
}

function isDummyOrNull(link: string | null) {
  if (link === null) return;
  expect(link.startsWith(DUMMY_PREFIX), `link ${link} must be a dummy`).toBe(true);
}

async function post(baseUrl: string, headers: Record<string, string>, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status, `seeding ${path}`).toBe(200);
  return res.json();
}

async function seed(baseUrl: string, headers: Record<string, string>) {
  await post(baseUrl, headers, "/api/subscriptions", {
    factuur: SUBSCRIPTION, kenmerk: "k", amount: 24.14, factuurdatum: INVOICE_DATE, thread_link: REAL.thread,
  });
  const factuur = await post(baseUrl, headers, "/api/facturen", {
    factuur: FACTUUR, klusnummer: `K-${RUN}`, klusomschrijving: "Lamp ophangen", klusadres: REAL.address,
    totaal: REAL.total, factuurdatum: INVOICE_DATE, thread_link: REAL.thread,
  });
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.4 demo-test"], { type: "application/pdf" }), "demo.pdf");
  const pdf = await fetch(`${baseUrl}/api/facturen/${factuur.id}/pdf`, { method: "POST", headers, body: form });
  expect(pdf.status, "seeding the factuur PDF").toBe(200);
  const withPdf = await pdf.json();

  await post(baseUrl, headers, "/api/appointments", { klusnummer: APPOINTMENT, thread_link: REAL.thread });
  await post(baseUrl, headers, `/api/appointments/${APPOINTMENT}/cancel`, { thread_link: REAL.thread });
  await post(baseUrl, headers, "/api/bookkeeping-entries", {
    kees_id: KEES_ID, invoice_number: `DEMO-KEES-${RUN}`, file_name: `DEMO-KEES-${RUN}`, description: "d",
    customer_name: "c", amount_incl: REAL.keesAmount, state: "UNPAID", invoice_date: INVOICE_DATE,
    raw: { secret: REAL.rawSecret },
  });
  return { factuurId: factuur.id as number, pdfUrl: withPdf.pdf_url as string };
}

test.describe("Demo account (anonymised view)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === "live", "demo checks are mock-only");
  });

  test("the owner still sees the real values (so the checks below prove something)", async ({ apiKeyHeaders, ownerApi }, testInfo) => {
    await seed(baseUrlFor(testInfo.project.name), apiKeyHeaders);
    const row = (await (await ownerApi.get("/api/facturen")).json()).find((f: any) => f.factuur === FACTUUR);
    expect(row.totaal).toBeCloseTo(REAL.total, 2);
    expect(row.thread_link).toBe(REAL.thread);
    expect(row.klusadres).toBe(REAL.address);
    expect(row.pdf_url).toMatch(/^\/uploads\//);
  });

  test("every price the demo user sees is 30-40 EUR and every link is a dummy", async ({ apiKeyHeaders, demoApi }, testInfo) => {
    await seed(baseUrlFor(testInfo.project.name), apiKeyHeaders);

    const facturen = await (await demoApi.get("/api/facturen")).json();
    expect(facturen.length).toBeGreaterThan(0);
    for (const f of facturen) {
      inDemoRange(f.totaal);
      isDummyOrNull(f.thread_link);
      isDummyOrNull(f.pdf_url);
    }
    const subscriptions = await (await demoApi.get("/api/subscriptions")).json();
    for (const s of subscriptions) {
      inDemoRange(s.amount);
      isDummyOrNull(s.thread_link);
      isDummyOrNull(s.pdf_url);
    }
    for (const a of await (await demoApi.get("/api/appointments")).json()) {
      isDummyOrNull(a.thread_link);
      isDummyOrNull(a.cancelled_thread_link);
    }
    const entries = await (await demoApi.get("/api/bookkeeping-entries")).json();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      inDemoRange(e.amount_incl);
      expect(e.raw, "the raw Kees payload must never reach the demo").toBeNull();
    }
    const compare = await (await demoApi.get("/api/bookkeeping/compare")).json();
    for (const f of compare.missing_in_bookkeeping) {
      inDemoRange(f.totaal);
      isDummyOrNull(f.thread_link);
      isDummyOrNull(f.pdf_url);
    }
    for (const e of compare.missing_in_facturen) {
      inDemoRange(e.amount_incl);
      expect(e.raw).toBeNull();
    }
    for (const week of await (await demoApi.get("/api/facturen/revenue-by-week")).json()) {
      expect(week.total).toBeGreaterThanOrEqual(30 * week.invoice_count);
      expect(week.total).toBeLessThanOrEqual(40 * week.invoice_count);
    }
  });

  test("the demo address keeps the street, postcode area and city but not the house number", async ({ apiKeyHeaders, demoApi }, testInfo) => {
    await seed(baseUrlFor(testInfo.project.name), apiKeyHeaders);
    const row = (await (await demoApi.get("/api/facturen")).json()).find((f: any) => f.factuur === FACTUUR);
    expect(row.klusadres).toBe("Mortelstraat, 1019 Amsterdam");
  });

  test("demo values are stable between requests and agree across the invoices and revenue tabs", async ({ apiKeyHeaders, demoApi }, testInfo) => {
    await seed(baseUrlFor(testInfo.project.name), apiKeyHeaders);

    // Other specs insert rows concurrently, so compare row by row: anything seen in both reads must
    // be identical (same price, same dummy links, same jitter), whatever else appeared in between.
    const first = await (await demoApi.get("/api/facturen")).json();
    const second = await (await demoApi.get("/api/facturen")).json();
    const secondById = new Map<number, unknown>(second.map((f: any) => [f.id, f]));
    for (const f of first) expect(secondById.get(f.id), `row ${f.id} changed between requests`).toEqual(f);

    // The weekly total must be the sum of the very prices the invoices list shows. Retry until both
    // reads were taken from a stable table.
    await expect(async () => {
      const before = await (await demoApi.get("/api/facturen")).json();
      const weeks = await (await demoApi.get("/api/facturen/revenue-by-week")).json();
      const after = await (await demoApi.get("/api/facturen")).json();
      expect(after.length, "facturen changed mid-read, retrying").toBe(before.length);

      const inWeek = after.filter((f: any) => f.factuurdatum === INVOICE_DATE);
      expect(inWeek.length).toBeGreaterThan(0);
      const bucket = weeks.find((w: any) => w.week_start <= INVOICE_DATE && INVOICE_DATE <= w.week_end);
      expect(bucket, "a weekly bucket must exist for the seeded invoice date").toBeTruthy();
      expect(bucket.invoice_count).toBe(inWeek.length);
      expect(bucket.total).toBeCloseTo(
        inWeek.reduce((sum: number, f: any) => sum + f.totaal, 0),
        2
      );
    }).toPass({ timeout: 15_000 });
  });

  test("nothing real leaks anywhere in the demo user's responses", async ({ apiKeyHeaders, demoApi }, testInfo) => {
    await seed(baseUrlFor(testInfo.project.name), apiKeyHeaders);
    const everything = JSON.stringify(
      await Promise.all(
        [
          "/api/auth/me",
          "/api/facturen",
          "/api/subscriptions",
          "/api/appointments",
          "/api/bookkeeping-entries",
          "/api/bookkeeping/compare",
          "/api/facturen/revenue-by-week",
        ].map(async (path) => (await demoApi.get(path)).json())
      )
    );
    for (const needle of [
      "mail.google.com",
      "REALTHREAD",
      "/uploads/",
      REAL.rawSecret,
      String(REAL.total),
      String(REAL.keesAmount),
      "Mortelstraat 117",
      "1019VE",
    ]) {
      expect(everything.includes(needle), `demo response must not contain "${needle}"`).toBe(false);
    }
  });

  test("the demo account cannot open the real uploaded files, the owner can", async ({ apiKeyHeaders, ownerApi, demoApi }, testInfo) => {
    const { pdfUrl } = await seed(baseUrlFor(testInfo.project.name), apiKeyHeaders);
    expect((await ownerApi.get(pdfUrl)).status()).toBe(200);
    expect((await demoApi.get(pdfUrl)).status()).toBe(403);
  });
});
