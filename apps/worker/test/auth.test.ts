import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authenticate, sha256Hex } from "../src/auth";
import { TenantAuth } from "../src/tenant-auth";
import { TEST_KEYS } from "./fixtures";

const whoami = (headers: HeadersInit = {}) =>
  exports.default.fetch("http://example.com/v1/whoami", { headers });

describe("tenant authentication (through the Worker)", () => {
  it("refuses a request without a key", async () => {
    const response = await whoami();

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: "missing_or_malformed_api_key" });
  });

  it("refuses a well-formed key that belongs to no tenant", async () => {
    const response = await whoami({ Authorization: `Bearer lg_${"C".repeat(43)}` });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_api_key" });
  });

  it.each([
    ["no Bearer prefix", TEST_KEYS.acme],
    ["wrong scheme", `Basic ${TEST_KEYS.acme}`],
    ["key with extra text", `Bearer ${TEST_KEYS.acme} x`],
    ["truncated key", `Bearer ${TEST_KEYS.acme.slice(0, -1)}`],
    ["oversized header", `Bearer ${"x".repeat(10_000)}`],
  ])("refuses a malformed header (%s)", async (_label, value) => {
    const response = await whoami({ Authorization: value });

    expect(response.status).toBe(401);
  });

  it("maps each valid key to its own tenant", async () => {
    const acme = await whoami({ Authorization: `Bearer ${TEST_KEYS.acme}` });
    const globex = await whoami({ Authorization: `Bearer ${TEST_KEYS.globex}` });

    expect(await acme.json()).toEqual({ tenant: "acme" });
    expect(await globex.json()).toEqual({ tenant: "globex" });
  });

  it("protects unknown /v1/ paths too (no route discovery without a key)", async () => {
    const response = await exports.default.fetch("http://example.com/v1/anything");

    expect(response.status).toBe(401);
  });
});

describe("authenticate (configuration)", () => {
  const request = new Request("http://example.com/v1/whoami", {
    headers: { Authorization: `Bearer ${TEST_KEYS.acme}` },
  });

  it.each([
    ["missing secret", undefined],
    ["value that is not JSON", "acme"],
    ["key that is not a hash", JSON.stringify({ [TEST_KEYS.acme]: "acme" })],
    ["bad tenant ID", JSON.stringify({ ["a".repeat(64)]: "Acme Corp" })],
  ])("fails closed with 500 on a %s", async (_label, tenantKeys) => {
    expect(await authenticate(request, tenantKeys)).toEqual({
      ok: false,
      status: 500,
      error: "server_misconfigured",
    });
  });

  it("accepts a secret with a byte-order mark or a trailing line break", async () => {
    const value = JSON.stringify({ [await sha256Hex(TEST_KEYS.acme)]: "acme" });

    for (const variant of [`\uFEFF${value}`, `${value}\r\n`]) {
      expect(await authenticate(request, variant)).toEqual({ ok: true, tenantId: "acme" });
    }
  });

  it("hashes like Node's crypto (same as scripts/new-tenant-key.mjs)", async () => {
    // SHA-256("abc") from FIPS 180-2, appendix B.1.
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("TenantAuth entrypoint (private, for the rulebook server's consent page, D47)", () => {
  it("returns the tenant of a valid key over RPC", async () => {
    expect(await exports.TenantAuth.tenantForKey(TEST_KEYS.acme)).toBe("acme");
    expect(await exports.TenantAuth.tenantForKey(TEST_KEYS.globex)).toBe("globex");
  });

  it("returns null for an unknown, malformed or non-string key", async () => {
    expect(await exports.TenantAuth.tenantForKey(`lg_${"C".repeat(43)}`)).toBeNull();
    expect(await exports.TenantAuth.tenantForKey(`${TEST_KEYS.acme} `)).toBeNull();
    expect(await exports.TenantAuth.tenantForKey("x".repeat(10_000))).toBeNull();
    // A caller could send anything over RPC; a number is not a key.
    expect(await exports.TenantAuth.tenantForKey(42 as unknown as string)).toBeNull();
  });

  it("is not reachable from the public URL", async () => {
    const response = await exports.default.fetch("http://example.com/tenantForKey", {
      method: "POST",
      body: TEST_KEYS.acme,
    });
    expect(response.status).toBe(404);
  });
});

describe("TenantAuth with a broken TENANT_KEYS secret", () => {
  it("throws instead of answering (fail closed)", async () => {
    const broken = new TenantAuth(createExecutionContext(), { ...env, TENANT_KEYS: "{not json" });
    await expect(broken.tenantForKey(TEST_KEYS.acme)).rejects.toThrow("server_misconfigured");
  });
});
