// Entry point of the Lexguard Worker. Cloudflare calls `fetch` once per HTTP request.
export default {
  fetch(request): Response {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return Response.json({ name: "lexguard", status: "ok" });
      case "/health":
        return new Response("ok");
      default:
        return new Response("Not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
