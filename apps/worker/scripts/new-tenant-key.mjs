// Creates a tenant API key. Run it yourself; never paste the key into chat or commit it.
//
//   node apps/worker/scripts/new-tenant-key.mjs <tenant-id> --set
//     Prints the new API key once (keep it) and stores its hash directly as the TENANT_KEYS
//     secret of the deployed Worker, through `wrangler secret put` (no copy-paste). This
//     REPLACES the whole secret: keys made earlier stop working. One tenant for now.
//
//   node apps/worker/scripts/new-tenant-key.mjs <tenant-id>
//     Only prints the key and the TENANT_KEYS entry (for .dev.vars, or to merge by hand).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const tenant = process.argv[2] ?? "";
const set = process.argv.includes("--set");
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) {
  console.error(
    "usage: new-tenant-key.mjs <tenant-id> [--set]  (tenant: lowercase letters, digits, dashes)",
  );
  process.exit(1);
}

const key = `lg_${randomBytes(32).toString("base64url")}`; // 256 bits of randomness
const hash = createHash("sha256").update(key).digest("hex");
const entry = JSON.stringify({ [hash]: tenant });

if (!set) {
  console.log(`API key (store it now, it is not saved anywhere):\n  ${key}\n`);
  console.log(`TENANT_KEYS entry:\n  ${entry}`);
  process.exit(0);
}

// The entry goes to wrangler on standard input: nothing to paste, nothing for a shell to parse.
const result = spawnSync("npx", ["wrangler", "secret", "put", "TENANT_KEYS"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  input: entry,
  encoding: "utf8",
  shell: process.platform === "win32", // npx is a .cmd file on Windows
});
if (result.status !== 0) {
  console.error(`wrangler secret put failed; nothing changed:\n${result.stderr}`);
  process.exit(1);
}
console.log(`TENANT_KEYS now holds the hash of a new key for tenant "${tenant}".\n`);
console.log(`Your API key (store it now, it is not saved anywhere, never share it):\n  ${key}`);
