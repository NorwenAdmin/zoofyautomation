import { MOCK_BASE_URL } from "../env.js";

async function main() {
  const timeoutMs = 60_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${MOCK_BASE_URL}/api/health`);
      if (res.ok) {
        console.log("Mock backend is healthy.");
        return;
      }
    } catch {
      // not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Mock backend at ${MOCK_BASE_URL} did not become healthy within ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
