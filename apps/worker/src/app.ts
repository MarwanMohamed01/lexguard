// Routing. Kept apart from index.ts so tests can pass their own dependencies (a fake
// converter, a fixed clock) while production passes the real ones.
import { authenticate } from "./auth";
import { countCreatedSince, getDocument } from "./documents";
import { handleUpload, type UploadDeps } from "./upload";

/**
 * New documents per tenant per day (threat T15). The Free plan's daily budgets are shared by
 * all tenants and stop everything when spent (D1: 100,000 rows written; a 300-page contract
 * writes about 700). 50 uploads is about a third of that, so one tenant cannot use it all.
 * Counted from 00:00 UTC, when Cloudflare resets the daily limits.
 */
export const DAILY_UPLOADS_PER_TENANT = 50;

async function checkDailyQuota(
  db: D1Database,
  tenantId: string,
  now: Date,
  limit: number,
): Promise<Response | null> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const used = await countCreatedSince(db, tenantId, midnight.toISOString());
  if (used < limit) return null;
  const retryAfter = Math.ceil((midnight.getTime() + 86_400_000 - now.getTime()) / 1000);
  return Response.json(
    { error: "daily_upload_limit", limit },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
const methodNotAllowed = (allow: string) =>
  Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: allow } });

export async function handle(request: Request, env: Env, deps: UploadDeps): Promise<Response> {
  const url = new URL(request.url);

  switch (url.pathname) {
    case "/":
      return Response.json({ name: "lexguard", status: "ok" });
    case "/health":
      return new Response("ok");
  }
  if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });
  return secured(await handleV1(request, url, env, deps));
}

/**
 * Every tenant response: never cached anywhere (it can carry contract metadata), and never
 * reinterpreted by a browser as another content type.
 */
function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

async function handleV1(request: Request, url: URL, env: Env, deps: UploadDeps): Promise<Response> {
  // Everything under /v1/ belongs to a tenant: no valid API key, no access.
  const auth = await authenticate(request, env.TENANT_KEYS);
  if (!auth.ok) {
    const headers: HeadersInit = auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
    return Response.json({ error: auth.error }, { status: auth.status, headers });
  }
  const { tenantId } = auth;

  if (url.pathname === "/v1/whoami") return Response.json({ tenant: tenantId });

  if (url.pathname === "/v1/documents") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const now = (deps.now ?? (() => new Date()))();
    const limit = deps.uploadsPerDay ?? DAILY_UPLOADS_PER_TENANT;
    const quota = await checkDailyQuota(env.DB, tenantId, now, limit);
    if (quota !== null) return quota;
    return handleUpload(request, env, tenantId, deps);
  }

  const match = /^\/v1\/documents\/([^/]+)$/.exec(url.pathname);
  if (match?.[1] !== undefined) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    // Another tenant's document answers exactly like a missing one: 404, never 403, so an ID
    // cannot be probed to learn that it exists.
    const id = match[1].toLowerCase();
    const document = UUID.test(id) ? await getDocument(env.DB, tenantId, id) : null;
    return document === null ? notFound() : Response.json({ document });
  }

  return notFound();
}
