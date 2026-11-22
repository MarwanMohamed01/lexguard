import { createHash } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_KEYS } from "./test/fixtures.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Runs tests inside the real Workers runtime (workerd via Miniflare), not plain Node, with a
// local D1 that gets the real migrations and a TENANT_KEYS secret built from fake keys.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const tenantKeys = Object.fromEntries(
    Object.entries(TEST_KEYS).map(([tenant, key]) => [sha256(key), tenant]),
  );
  // Wrangler reads required secrets from process.env (like .dev.vars for `wrangler dev`).
  process.env.TENANT_KEYS = JSON.stringify(tenantKeys);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Never reach Cloudflare from tests (CI has no login): env.AI is unusable here, and
        // upload tests pass a fake converter instead.
        remoteBindings: false,
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
