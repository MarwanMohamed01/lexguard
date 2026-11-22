// Entry point of the Lexguard Worker. Cloudflare calls `fetch` once per HTTP request.
import { authenticate } from "./auth";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return Response.json({ name: "lexguard", status: "ok" });
      case "/health":
        return new Response("ok");
    }

    // Everything under /v1/ belongs to a tenant: no valid API key, no access.
    if (url.pathname.startsWith("/v1/")) {
      const auth = await authenticate(request, env.TENANT_KEYS);
      if (!auth.ok) {
        const headers: HeadersInit = auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
        return Response.json({ error: auth.error }, { status: auth.status, headers });
      }
      if (url.pathname === "/v1/whoami") return Response.json({ tenant: auth.tenantId });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
