import { test as base, type APIRequestContext, request } from "@playwright/test";
import {
  baseUrlFor,
  LIVE_OWNER_EMAIL,
  LIVE_OWNER_PASSWORD,
  MOCK_API_KEY,
  MOCK_OWNER_EMAIL,
  MOCK_OWNER_PASSWORD,
} from "../env.js";

// US-4: tests authenticate the same way real clients do — a real session-cookie login for the
// owner (GET endpoints), a real X-API-Key header for the machine client (POST endpoints, mock
// only — the "live" project is read-only, see US-3, so it never needs the API key).
type Fixtures = {
  ownerApi: APIRequestContext;
  apiKeyHeaders: Record<string, string>;
};

export const test = base.extend<Fixtures>({
  ownerApi: async ({ playwright: _pw }, use, testInfo) => {
    const baseURL = baseUrlFor(testInfo.project.name);
    const [email, password] =
      testInfo.project.name === "live"
        ? [LIVE_OWNER_EMAIL, LIVE_OWNER_PASSWORD]
        : [MOCK_OWNER_EMAIL, MOCK_OWNER_PASSWORD];

    if (testInfo.project.name === "live" && (!email || !password)) {
      throw new Error(
        "LIVE_OWNER_EMAIL / LIVE_OWNER_PASSWORD are not set — copy tests/.env.example to tests/.env and fill them in."
      );
    }

    const context = await request.newContext({ baseURL });
    const loginRes = await context.post("/api/auth/login", {
      data: { email, password },
    });
    if (!loginRes.ok()) {
      throw new Error(`Owner login failed against ${baseURL}: HTTP ${loginRes.status()} — ${await loginRes.text()}`);
    }
    await use(context);
    await context.dispose();
  },

  apiKeyHeaders: async ({}, use, testInfo) => {
    if (testInfo.project.name === "live") {
      throw new Error("apiKeyHeaders was used in the 'live' project — POST/mutation tests must be mock-only (US-3)");
    }
    await use({ "X-API-Key": MOCK_API_KEY });
  },
});

export { expect } from "@playwright/test";
