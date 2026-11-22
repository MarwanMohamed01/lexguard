// Routing. Kept apart from index.ts so tests can pass their own dependencies (a fake
// converter, a fixed clock) while production passes the real ones.
import { authenticate } from "./auth";
import { getDocument } from "./documents";
import { handleUpload, type UploadDeps } from "./upload";

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
