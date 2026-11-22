// Tenant authentication: `Authorization: Bearer <api key>` -> tenant ID.
//
// The Worker never stores API keys, only their SHA-256 hashes, in the TENANT_KEYS secret
// (JSON object {"<sha256 hex>": "<tenant id>"}). Someone who reads the configuration learns
// the hashes, which cannot be turned back into usable keys (keys carry 256 random bits, so
// guessing is hopeless). Same reason passwords are stored hashed.
//
// Lookup by hash also avoids a timing leak: the attacker chooses the key, not its hash, so
// how fast the map lookup answers says nothing useful about valid keys.
import { z } from "zod";

/** `lg_` + 32 random bytes in base64url (43 chars). Matches scripts/new-tenant-key.mjs. */
const KEY_PATTERN = /^lg_[A-Za-z0-9_-]{43}$/;

export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const TenantKeysSchema = z.record(
  z.string().regex(/^[0-9a-f]{64}$/, "keys must be SHA-256 hex"),
  z.string().regex(TENANT_ID_PATTERN, "tenant IDs: lowercase letters, digits, dashes"),
);

export type AuthResult =
  { ok: true; tenantId: string } | { ok: false; status: 401 | 500; error: string };

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Parsed once per isolate (and again only if the secret changes), not on every request.
let cache: { raw: string; byHash: ReadonlyMap<string, string> | null } | null = null;

function parseTenantKeys(raw: string | undefined): ReadonlyMap<string, string> | null {
  if (raw === undefined) return null;
  if (cache?.raw !== raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const result = TenantKeysSchema.safeParse(parsed);
    cache = { raw, byHash: result.success ? new Map(Object.entries(result.data)) : null };
  }
  return cache.byHash;
}

export async function authenticate(
  request: Request,
  tenantKeys: string | undefined,
): Promise<AuthResult> {
  // Fail closed: a missing or broken secret refuses everyone instead of letting anyone in.
  const byHash = parseTenantKeys(tenantKeys);
  if (byHash === null) return { ok: false, status: 500, error: "server_misconfigured" };

  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") ?? "");
  const key = match?.[1];
  // The format check rejects junk (and huge headers) before any hashing work.
  if (key === undefined || !KEY_PATTERN.test(key)) {
    return { ok: false, status: 401, error: "missing_or_malformed_api_key" };
  }

  const tenantId = byHash.get(await sha256Hex(key));
  return tenantId === undefined
    ? { ok: false, status: 401, error: "invalid_api_key" }
    : { ok: true, tenantId };
}
