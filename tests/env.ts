export const MOCK_BASE_URL = "http://127.0.0.1:8003";
export const LIVE_BASE_URL = "https://zoofyautomation.norwen.nl";

export const MOCK_API_KEY = "test-api-key";

// Live owner login — a real account on the deployed instance. Never used for anything but GET
// requests (see US-3: the "live" project is read-only by design). Loaded from the environment
// (tests/.env, gitignored — see .env.example) rather than hardcoded, since this is a real
// production credential.
export const LIVE_OWNER_EMAIL = process.env.LIVE_OWNER_EMAIL ?? "";
export const LIVE_OWNER_PASSWORD = process.env.LIVE_OWNER_PASSWORD ?? "";

// Mock gets its own throwaway owner account, registered fresh by global setup against the
// disposable mock Postgres — never touches the real user table.
export const MOCK_OWNER_EMAIL = "test-owner@example.com";
export const MOCK_OWNER_PASSWORD = "test-password-123";
export const MOCK_OWNER_NAME = "Test Owner";

export function baseUrlFor(projectName: string): string {
  return projectName === "live" ? LIVE_BASE_URL : MOCK_BASE_URL;
}
