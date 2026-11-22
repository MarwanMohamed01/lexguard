// Creates a tenant API key. Run it yourself; never paste the key into chat or commit it.
//   node apps/worker/scripts/new-tenant-key.mjs <tenant-id>
// Prints the key (give it to the tenant, shown once) and the TENANT_KEYS entry, which holds
// only the key's SHA-256. Merge entries into one JSON object, then:
//   npx wrangler secret put TENANT_KEYS     (from apps/worker; paste the JSON when asked)
import { createHash, randomBytes } from "node:crypto";

const tenant = process.argv[2] ?? "";
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) {
  console.error("usage: new-tenant-key.mjs <tenant-id>  (lowercase letters, digits, dashes)");
  process.exit(1);
}

const key = `lg_${randomBytes(32).toString("base64url")}`; // 256 bits of randomness
const hash = createHash("sha256").update(key).digest("hex");
console.log(`API key (store it now, it is not saved anywhere):\n  ${key}\n`);
console.log(`TENANT_KEYS entry:\n  ${JSON.stringify({ [hash]: tenant })}`);
