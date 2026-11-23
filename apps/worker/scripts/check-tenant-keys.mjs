// Checks a TENANT_KEYS value before you store it, with the same rules as src/auth.ts, without
// printing it. Reads the value from standard input:
//   '{"<sha256 hex>":"<tenant>"}' | node apps/worker/scripts/check-tenant-keys.mjs
// (PowerShell: single quotes keep the double quotes intact.)

let input = "";
for await (const chunk of process.stdin) input += chunk;
const value = input.trim();

function fail(reason) {
  console.error(`INVALID: ${reason}`);
  process.exit(1);
}

if (value.startsWith("lg_"))
  fail("this looks like an API key; TENANT_KEYS holds its hash (the JSON line)");
let parsed;
try {
  parsed = JSON.parse(value);
} catch {
  fail("not valid JSON (check that the whole line was copied, braces and quotes included)");
}
if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  fail("must be a JSON object");
}
const entries = Object.entries(parsed);
if (entries.length === 0) fail("no tenants in it");
for (const [hash, tenant] of entries) {
  if (!/^[0-9a-f]{64}$/.test(hash)) fail("a key is not a 64-character lowercase hex SHA-256");
  if (typeof tenant !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) {
    fail("a tenant ID is not lowercase letters, digits and dashes");
  }
}
console.log(`valid: ${String(entries.length)} tenant(s): ${entries.map(([, t]) => t).join(", ")}`);
