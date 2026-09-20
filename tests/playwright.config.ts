import "dotenv/config";
import { defineConfig } from "@playwright/test";
import { LIVE_BASE_URL, MOCK_BASE_URL } from "./env.js";

// US-3: "mock" = throwaway instance + throwaway Postgres, full CRUD allowed.
// "live" = the real deployment, GET-only by convention (enforced by the apiKeyHeaders fixture
// refusing to run in this project — see fixtures/auth.ts).
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  projects: [
    {
      name: "mock",
      use: { baseURL: MOCK_BASE_URL },
    },
    {
      name: "live",
      use: { baseURL: LIVE_BASE_URL },
    },
  ],
});
