import { MOCK_BASE_URL, MOCK_OWNER_EMAIL, MOCK_OWNER_NAME, MOCK_OWNER_PASSWORD } from "../env.js";

// Idempotent: if this runs twice against the same mock DB (shouldn't normally happen since the
// stack is torn down between runs), a 400 "already exists" is fine to ignore.
async function main() {
  const res = await fetch(`${MOCK_BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: MOCK_OWNER_EMAIL,
      password: MOCK_OWNER_PASSWORD,
      name: MOCK_OWNER_NAME,
    }),
  });
  if (res.ok || res.status === 400) {
    console.log(`Seeded mock owner account (status ${res.status}).`);
    return;
  }
  throw new Error(`Failed to seed mock owner account: HTTP ${res.status} — ${await res.text()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
