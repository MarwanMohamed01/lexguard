// Who may register itself as an OAuth client (dynamic client registration, RFC 7591; D48).
//
// MCP Inspector and other desktop MCP clients can only sign in by registering themselves on
// the fly. Each registration is a KV write (1,000 a day free), so it is limited to apps on
// this computer: every redirect URI must point at localhost. Hosted clients identify with a
// Client ID Metadata Document instead and never register.
//
//   allowed: http://localhost:6274/oauth/callback, http://127.0.0.1:33418/cb, http://[::1]/cb
//   refused: https://attacker.example/cb, javascript:..., a mix of the two
import type { ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A loopback http(s) redirect URI with nothing hidden in it (no user info, no fragment). */
export function isLoopbackRedirect(uri: unknown): boolean {
  if (typeof uri !== "string" || uri.length > 200) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

const reject = (code: string, description: string): ClientRegistrationCallbackResult => ({
  code,
  description,
  status: 400,
});

/** The registration callback: undefined allows the client, an object refuses it. */
export function registrationPolicy({
  clientMetadata,
}: {
  clientMetadata: Record<string, unknown>;
}): ClientRegistrationCallbackResult | undefined {
  const uris = clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) {
    return reject("invalid_redirect_uri", "Between 1 and 5 redirect URIs are required.");
  }
  if (!uris.every(isLoopbackRedirect)) {
    return reject(
      "invalid_redirect_uri",
      "Only apps on this computer (localhost redirect URIs) may register here. Hosted clients " +
        "identify with a Client ID Metadata Document.",
    );
  }
  const name = clientMetadata.client_name;
  if (name !== undefined && (typeof name !== "string" || name.length > 100)) {
    return reject(
      "invalid_client_metadata",
      "client_name must be a string of at most 100 characters.",
    );
  }
  return undefined;
}
