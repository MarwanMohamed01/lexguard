import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { oauthOptions, SCOPE } from "../src/index";
import { KEY_WITH_BAD_TENANT, OVERLONG_KEY, TEST_KEY, TEST_ORIGIN, TEST_TENANT } from "./fixtures";

// The whole OAuth 2.1 flow against the real Worker in workerd (D47): discovery, the consent
// page, sign-in with an API key, authorization code + PKCE, the token, then MCP calls. And the
// private service-binding door.

const RESOURCE = `${TEST_ORIGIN}/mcp`;
const REDIRECT = "https://client.test/callback";

// redirect: "manual", as in a browser handing the redirect to the client app: otherwise the
// test runtime follows a 302 to client.test back into this Worker.
const app = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${TEST_ORIGIN}${path}`, { redirect: "manual", ...init }));

const helpers = () => getOAuthApi(oauthOptions(env), env);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function registerClient(clientName = "Test client") {
  const client = await helpers().createClient({
    redirectUris: [REDIRECT],
    clientName,
    tokenEndpointAuthMethod: "none", // a public client, like a desktop app: PKCE required
  });
  return client.clientId;
}

const authorizeQuery = (clientId: string, challenge: string) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();

/** GET /authorize: the consent page, its one-use handle and the browser cookie it set. */
async function openConsent(clientId: string, challenge: string) {
  const response = await app(`/authorize?${authorizeQuery(clientId, challenge)}`);
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { response, html, handle, cookie };
}

const submit = (cookie: string, fields: Record<string, string>) =>
  app("/authorize", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

async function exchange(clientId: string, code: string, verifier: string) {
  const response = await app("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** The whole flow as a person would do it; returns the access token. */
async function signIn() {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const { handle, cookie } = await openConsent(clientId, challenge);
  const approved = await submit(cookie, { handle, decision: "approve", api_key: TEST_KEY });
  const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  const token = await exchange(clientId, code, verifier);
  return String(token.body.access_token);
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function mcpClient(fetchFn: (request: Request) => Promise<Response>, url = RESOURCE) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      fetch: (input, init) => fetchFn(new Request(input, init)),
    }),
  );
  clients.push(client);
  return client;
}

const withToken = (token: string) => (request: Request) => {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return exports.default.fetch(new Request(request, { headers }));
};

describe("discovery (how a client finds out where to sign in)", () => {
  it("answers /mcp without a token with 401 pointing at the resource metadata", async () => {
    const response = await app("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain(
      `resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain(`scope="${SCOPE}"`);
  });

  it("publishes the resource and authorization server metadata", async () => {
    const resource = await (
      await app("/.well-known/oauth-protected-resource/mcp")
    ).json<Record<string, unknown>>();
    expect(resource).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [TEST_ORIGIN],
      scopes_supported: [SCOPE],
    });
    const server = await (
      await app("/.well-known/oauth-authorization-server")
    ).json<Record<string, unknown>>();
    expect(server).toMatchObject({
      issuer: TEST_ORIGIN,
      authorization_endpoint: `${TEST_ORIGIN}/authorize`,
      token_endpoint: `${TEST_ORIGIN}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
    // Dynamic registration is off (D47): no endpoint advertised, none served.
    expect(server.registration_endpoint).toBeUndefined();
    // Clients identify themselves by a metadata document URL instead (CIMD).
    expect(server.client_id_metadata_document_supported).toBe(true);
  });
});

describe("the consent page", () => {
  it("shows the client, where tokens go and the scope, with client values escaped", async () => {
    const clientId = await registerClient('Evil <script>alert("x")</script> app');
    const { response, html, handle } = await openConsent(clientId, (await pkce()).challenge);
    expect(response.status).toBe(200);
    expect(html).toContain("Evil &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; app");
    expect(html).not.toContain("<script>");
    expect(html).toContain("client.test"); // the redirect host
    expect(html).toContain("rules:read");
    expect(html).toContain('type="password" name="api_key"');
    expect(handle).not.toBe("");
    // Not frameable (clickjacking): the library's headers say so.
    const framing = `${response.headers.get("X-Frame-Options") ?? ""} ${response.headers.get("Content-Security-Policy") ?? ""}`;
    expect(framing).toMatch(/DENY|frame-ancestors 'none'/i);
  });

  it("warns when the tokens go to an app on this computer", async () => {
    const local = await helpers().createClient({
      redirectUris: ["http://127.0.0.1:33418/callback"],
      clientName: "Local app",
      tokenEndpointAuthMethod: "none",
    });
    const query = authorizeQuery(local.clientId, (await pkce()).challenge).replace(
      encodeURIComponent(REDIRECT),
      encodeURIComponent("http://127.0.0.1:33418/callback"),
    );
    const html = await (await app(`/authorize?${query}`)).text();
    expect(html).toContain("This sends access to an app on your computer.");
    const remote = await openConsent(await registerClient(), (await pkce()).challenge);
    expect(remote.html).not.toContain("app on your computer");
  });

  it("redirects an error to a validated client (bad request option, known redirect URI)", async () => {
    const clientId = await registerClient();
    const query = authorizeQuery(clientId, (await pkce()).challenge).replace(
      "response_type=code",
      "response_type=token", // the implicit grant, removed in OAuth 2.1
    );
    const response = await app(`/authorize?${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).not.toBeNull();
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses an authorization request with a redirect URI the client did not register", async () => {
    const clientId = await registerClient();
    const query = authorizeQuery(clientId, (await pkce()).challenge).replace(
      encodeURIComponent(REDIRECT),
      encodeURIComponent("https://attacker.test/cb"),
    );
    const response = await app(`/authorize?${query}`);
    expect(response.status).toBe(400); // rendered here, never redirected to the attacker
    expect(response.headers.get("Location")).toBeNull();
  });
});

describe("signing in and getting a token", () => {
  it("runs the whole flow: wrong key refused, right key approved, token works for MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();
    const { handle, cookie } = await openConsent(clientId, challenge);

    const wrong = await submit(cookie, {
      handle,
      decision: "approve",
      api_key: `lg_${"X".repeat(43)}`,
    });
    expect(wrong.status).toBe(401);

    // The handle was not consumed by the failed sign-in, so the same form still works.
    const approved = await submit(cookie, { handle, decision: "approve", api_key: TEST_KEY });
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(TEST_ORIGIN);

    const token = await exchange(clientId, location.searchParams.get("code") ?? "", verifier);
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: "bearer", scope: SCOPE, resource: RESOURCE });
    expect(Number(token.body.expires_in)).toBeLessThanOrEqual(3_600);

    const client = await mcpClient(withToken(String(token.body.access_token)));
    const rule = await client.callTool({ name: "get_rule", arguments: { id: "gdpr:28(3)(a)" } });
    expect(rule.isError).not.toBe(true);

    // The grant belongs to the tenant who signed in.
    const grants = await helpers().listUserGrants(TEST_TENANT);
    expect(grants.items.some((g) => g.clientId === clientId)).toBe(true);
  });

  it("checks the main Worker's answer too: a malformed tenant or an overlong key is refused", async () => {
    const clientId = await registerClient();
    const { handle, cookie } = await openConsent(clientId, (await pkce()).challenge);
    // The stand-in main Worker answers these wrongly on purpose (test/fixtures.ts).
    const badTenant = await submit(cookie, {
      handle,
      decision: "approve",
      api_key: KEY_WITH_BAD_TENANT,
    });
    expect(badTenant.status).toBe(401);
    const overlong = await submit(cookie, { handle, decision: "approve", api_key: OVERLONG_KEY });
    expect(overlong.status).toBe(401);
  });

  it("grants only rules:read, even when a client asks for more", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();
    const query = authorizeQuery(clientId, challenge).replace(
      `scope=${encodeURIComponent(SCOPE)}`,
      `scope=${encodeURIComponent(`${SCOPE} admin:write`)}`,
    );
    const page = await app(`/authorize?${query}`);
    const html = await page.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = page.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(html).toContain("admin:write"); // shown to the person, with "Unknown scope."
    const approved = await submit(cookie, { handle, decision: "approve", api_key: TEST_KEY });
    const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code") ?? "";
    const token = await exchange(clientId, code, verifier);
    expect(token.body.scope).toBe(SCOPE);
  });

  it("sends access_denied back to the client when the person clicks Deny", async () => {
    const clientId = await registerClient();
    const { handle, cookie } = await openConsent(clientId, (await pkce()).challenge);
    const denied = await submit(cookie, { handle, decision: "deny" });
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("Location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses a forged form (no consent cookie) and a reused handle", async () => {
    const clientId = await registerClient();
    const { handle, cookie } = await openConsent(clientId, (await pkce()).challenge);
    const forged = await submit("", { handle, decision: "approve", api_key: TEST_KEY });
    expect(forged.status).toBe(400);
    expect(forged.headers.get("Location")).toBeNull();

    expect((await submit(cookie, { handle, decision: "approve", api_key: TEST_KEY })).status).toBe(
      302,
    );
    const again = await submit(cookie, { handle, decision: "approve", api_key: TEST_KEY });
    expect(again.status).toBe(400);
  });

  it("refuses a code used twice and a wrong PKCE verifier", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();
    const { handle, cookie } = await openConsent(clientId, challenge);
    const approved = await submit(cookie, { handle, decision: "approve", api_key: TEST_KEY });
    const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code") ?? "";

    // Someone who intercepted the code but not the verifier gets nothing.
    const wrongVerifier = await exchange(clientId, code, (await pkce()).verifier);
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe("invalid_grant");
    // The real client, holding the verifier, can still redeem it (the library does not burn a
    // code on a failed check), but only once.
    expect((await exchange(clientId, code, verifier)).status).toBe(200);
    const reused = await exchange(clientId, code, verifier);
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe("invalid_grant");
  });
});

describe("using a token at /mcp", () => {
  it("refuses a made-up token", async () => {
    const response = await withToken("not-a-real-token")(
      new Request(RESOURCE, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(401);
  });

  it("answers 403 insufficient_scope to a valid token without rules:read", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();
    // A grant with no scopes, made directly with the library's helpers.
    const request = await helpers().parseAuthRequest(
      new Request(`${TEST_ORIGIN}/authorize?${authorizeQuery(clientId, challenge)}`),
    );
    const { redirectTo } = await helpers().completeAuthorization({
      request,
      userId: TEST_TENANT,
      metadata: {},
      scope: [],
      props: { tenantId: TEST_TENANT },
    });
    const code = new URL(redirectTo).searchParams.get("code") ?? "";
    const token = await exchange(clientId, code, verifier);
    const response = await withToken(String(token.body.access_token))(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
  });

  it("ignores a tenant header on the public door: no token, no access", async () => {
    const response = await app("/mcp", {
      method: "POST",
      headers: { "X-Lexguard-Tenant": TEST_TENANT, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("keeps signed-in access working across several MCP calls", async () => {
    const client = await mcpClient(withToken(await signIn()));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(3);
  });
});

describe("the private door (service binding, D47)", () => {
  const internal = (tenant: string | null) => (request: Request) => {
    const headers = new Headers(request.headers);
    if (tenant !== null) headers.set("X-Lexguard-Tenant", tenant);
    return exports.RulebookInternal.fetch(new Request(request, { headers }));
  };

  it("serves the same MCP tools to Lexguard's own Workers, no token needed", async () => {
    const client = await mcpClient(internal(TEST_TENANT), "https://internal/mcp");
    const result = await client.callTool({ name: "get_rule", arguments: { id: "nda:11" } });
    expect(result.structuredContent).toMatchObject({ rule: { id: "nda:11" } });
  });

  it("requires a well-formed tenant and serves only /mcp", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(
      (await internal(null)(new Request("https://internal/mcp", { method: "POST", body }))).status,
    ).toBe(400);
    expect(
      (
        await internal("Not A Tenant!")(
          new Request("https://internal/mcp", { method: "POST", body }),
        )
      ).status,
    ).toBe(400);
    expect((await internal(TEST_TENANT)(new Request("https://internal/other"))).status).toBe(404);
  });
});
