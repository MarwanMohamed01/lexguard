import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import {
  KEY_WITH_BAD_TENANT,
  OVERLONG_KEY,
  TEST_KEY,
  TEST_ORIGIN,
  TEST_TENANT,
} from "./test/fixtures";

// A stand-in for the main Worker ("lexguard") with the same private TenantAuth entrypoint the
// rulebook Worker binds to. The real one is tested in apps/worker/test/auth.test.ts.
const tenantAuthStub = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class TenantAuth extends WorkerEntrypoint {
  async tenantForKey(key) {
    if (key === ${JSON.stringify(TEST_KEY)} || key === ${JSON.stringify(OVERLONG_KEY)}) return ${JSON.stringify(TEST_TENANT)};
    if (key === ${JSON.stringify(KEY_WITH_BAD_TENANT)}) return "Not A Tenant!";
    return null;
  }
}
export default { fetch() { return new Response("stub", { status: 404 }); } };
`;

// Runs tests inside the real Workers runtime (workerd via Miniflare) with a local KV.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false, // never reach Cloudflare from tests
      miniflare: {
        bindings: { PUBLIC_ORIGIN: TEST_ORIGIN },
        workers: [
          {
            name: "lexguard",
            modules: true,
            compatibilityDate: "2026-11-01",
            script: tenantAuthStub,
          },
        ],
      },
    }),
  ],
});
