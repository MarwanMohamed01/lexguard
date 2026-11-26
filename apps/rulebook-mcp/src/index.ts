// The rulebook MCP Worker (M5 step 4b, D47). Two doors to the same MCP server (server.ts):
//
//   Public door: https://<origin>/mcp, full OAuth 2.1 (@cloudflare/workers-oauth-provider).
//     An MCP client (Claude Desktop, MCP Inspector) gets 401 + where to sign in, sends a person
//     to /authorize, the person signs in with their Lexguard API key and approves, the client
//     gets a short-lived token bound to this resource with scope rules:read.
//   Private door: the RulebookInternal entrypoint, reachable only through a service binding
//     from Lexguard's own Workers (the review pipeline has no person to click "Allow", and
//     the OAuth library has no client-credentials grant). It never answers the public URL.
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  insufficientScope,
  type OAuthHelpers,
  type OAuthProviderOptions,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { consentPage, messagePage } from "./consent";
import { registrationPolicy } from "./registration";
import { rulebookHandler } from "./server";

export const SCOPE = "rules:read";
export const REGISTER_PATH = "/oauth/register";

/** What a grant remembers about who approved it (encrypted by the library). */
export interface GrantProps {
  tenantId: string;
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The main Worker's TenantAuth entrypoint (apps/worker/src/tenant-auth.ts), as seen over RPC. */
interface TenantAuthRpc {
  tenantForKey(key: string): Promise<string | null>;
}
const tenantAuth = (env: Env) => env.TENANT_AUTH as unknown as TenantAuthRpc;

/** The OAuth library injects its helpers into the env it hands the default handler. */
const oauthHelpers = (env: Env) => (env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
const mcp = rulebookHandler();

/** /mcp behind a valid token: the library has checked the token and its audience already. */
const api = {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext) {
    // OAuthProvider calls apiHandler with ctx.auth (the verified token) and ctx.props (what
    // completeAuthorization stored); its option type only says ExecutionContext.
    const { auth, props } = ctx as OAuthResourceContext<GrantProps>;
    // The library advertises the required scope but leaves enforcing it to us.
    if (!auth.scope.includes(SCOPE)) return insufficientScope(auth, [SCOPE]);
    return mcp.fetch(request, {
      authInfo: {
        token: auth.token,
        clientId: auth.clientId ?? "unknown",
        scopes: auth.scope,
        extra: { tenantId: props.tenantId, via: "oauth" },
        ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
      },
    });
  },
};

/** Everything that is not /mcp or an OAuth endpoint the library owns. */
const site = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") {
      try {
        if (request.method === "GET") return await showConsent(request, env);
        if (request.method === "POST") return await answerConsent(request, env);
        return messagePage(405, "Method not allowed.");
      } catch (error) {
        // Redirect to the client only when the library validated it (the guide's table).
        if (error instanceof AuthorizationError && error.redirectTo !== undefined) {
          return Response.redirect(error.redirectTo, 302);
        }
        if (error instanceof AuthorizationError) return messagePage(400, error.description);
        if (error instanceof CimdFetchError)
          return messagePage(400, "This app could not be verified.");
        throw error; // a bug or an outage: a 500, never a silent success
      }
    }
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({ name: "lexguard-rulebook", mcp: `${env.PUBLIC_ORIGIN}/mcp` });
    }
    return new Response("Not found", { status: 404 });
  },
};

async function showConsent(request: Request, env: Env): Promise<Response> {
  const oauth = oauthHelpers(env);
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest); // before beginConsent: no KV write on failure
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("X-Content-Type-Options", "nosniff");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function answerConsent(request: Request, env: Env): Promise<Response> {
  const oauth = oauthHelpers(env);
  const form = await request.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string") return messagePage(400, "The form is incomplete. Start again.");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  // Sign-in first, without consuming the handle: a wrong key leaves the form usable (Back).
  const key = form.get("api_key");
  const tenantId =
    typeof key === "string" && key.length <= 100 ? await tenantAuth(env).tenantForKey(key) : null;
  if (tenantId === null || !TENANT_ID.test(tenantId)) {
    return messagePage(401, "That API key is not valid. Go back and try again.");
  }

  // The request comes back from server-side storage, not from the form; the scope is ours.
  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: tenantId,
    metadata: {},
    scope: [SCOPE],
    props: { tenantId } satisfies GrantProps,
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

/** The provider's options for this deployment's origin. Exported for tests (helpers). */
export function oauthOptions(env: Env): OAuthProviderOptions<Env> {
  const origin = env.PUBLIC_ORIGIN;
  return {
    apiRoute: "/mcp",
    apiHandler: api,
    defaultHandler: site,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    // Hosted clients identify by a metadata document URL (CIMD, MCP 2026-07-28). Desktop
    // clients such as MCP Inspector can only register themselves (DCR), so registration is
    // on but guarded (D48): localhost redirect URIs only, records expire after a day, and
    // bursts are rate-limited in front of the provider (see the default export).
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: REGISTER_PATH,
    clientRegistrationCallback: registrationPolicy,
    clientRegistrationTTL: 86_400, // KV deletes abandoned registrations after 1 day
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    accessTokenTTL: 3_600, // 1 hour
    refreshTokenTTL: 7 * 86_400, // a grant lasts 7 days at most
  };
}

let provider: { origin: string; instance: OAuthProvider<Env> } | null = null;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Burst limit on self-registration (D48). Approximate and per Cloudflare location, so it
    // slows a script down but cannot cap the day's total (that needs an atomic counter, M7).
    if (request.method === "POST" && new URL(request.url).pathname === REGISTER_PATH) {
      const { success } = await env.REGISTER_LIMIT.limit({ key: "register" });
      if (!success) {
        return Response.json(
          { error: "temporarily_unavailable", error_description: "Too many registrations." },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
    }
    if (provider?.origin !== env.PUBLIC_ORIGIN) {
      provider = { origin: env.PUBLIC_ORIGIN, instance: new OAuthProvider(oauthOptions(env)) };
    }
    return await provider.instance.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/**
 * The private door (D47): Lexguard's own Workers call the same MCP server through a service
 * binding, saying which tenant the call is for. The caller has already authenticated that
 * tenant; only Workers in this Cloudflare account can bind to this entrypoint.
 */
export class RulebookInternal extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const tenantId = request.headers.get("X-Lexguard-Tenant") ?? "";
    if (!TENANT_ID.test(tenantId)) return new Response("Missing tenant", { status: 400 });
    return mcp.fetch(request, {
      authInfo: {
        token: "service-binding",
        clientId: "lexguard-pipeline",
        scopes: [SCOPE],
        extra: { tenantId, via: "service-binding" },
      },
    });
  }
}
