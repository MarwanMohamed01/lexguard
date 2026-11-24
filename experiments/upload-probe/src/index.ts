// Upload CPU probe (M2 step 7, D23): where do the ~28 ms of CPU of a 154-page upload go?
// Each route does one piece of the real upload path, so Cloudflare's per-invocation CPU time
// (`wrangler tail`, cpuTime) can be compared piece by piece. performance.now() is frozen
// during CPU work on deployed Workers, so the numbers come from Cloudflare, not this code.
//
//   POST /noop            nothing (the baseline cost of an invocation with a big body unread)
//   POST /read            read the whole body (arrayBuffer)
//   POST /read-stream     read it the way the Worker does (native FixedLengthStream)
//   POST /hash            read + SHA-256
//   POST /convert         read + toMarkdown (same options as the Worker); returns text length
//   POST /sanitize        body is converted text: sanitize + page extraction
//   POST /d1              body is converted text: write it to D1 (one row)
//   POST /all             PDF: read + hash + convert + sanitize + pages + D1 write
import { sanitizeText } from "../../../packages/guardrails/src/sanitize";
import { extractPages } from "../../../apps/worker/src/pages";
import { CONVERSION_OPTIONS, readExactly } from "../../../apps/worker/src/upload";

interface ProbeEnv {
  AI: Ai;
  DB: D1Database;
}

const MAX = 10 * 1024 * 1024;
const length = (request: Request) =>
  Math.min(Number(request.headers.get("Content-Length") ?? 0), MAX);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function convert(env: ProbeEnv, bytes: Uint8Array): Promise<string> {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const result = await env.AI.toMarkdown({ name: "document.pdf", blob }, CONVERSION_OPTIONS);
  if (result.format === "error") throw new Error(result.error);
  return result.data;
}

async function store(env: ProbeEnv, text: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO probe (id, text) VALUES (1, ?)").bind(text).run();
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/noop":
        return Response.json({ ok: true });
      case "/read":
        return Response.json({ bytes: (await request.arrayBuffer()).byteLength });
      case "/read-stream":
        return Response.json({
          bytes: (await readExactly(request, length(request)))?.length ?? -1,
        });
      case "/hash": {
        const bytes = new Uint8Array(await request.arrayBuffer());
        return Response.json({ sha256: await sha256(bytes) });
      }
      case "/convert": {
        const bytes = new Uint8Array(await request.arrayBuffer());
        return Response.json({ chars: (await convert(env, bytes)).length });
      }
      case "/sanitize": {
        const text = await request.text();
        const { text: clean } = sanitizeText(text);
        const { text: paged, pageStarts } = extractPages(clean);
        return Response.json({ chars: paged.length, pages: pageStarts?.length ?? null });
      }
      case "/convert-text": {
        // Setup, not measured: returns toMarkdown's raw text for the text routes, and makes
        // sure the probe table exists so /d1 measures only the write.
        await env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, text TEXT)",
        ).run();
        return new Response(await convert(env, new Uint8Array(await request.arrayBuffer())));
      }
      case "/d1":
        await store(env, await request.text());
        return Response.json({ ok: true });
      case "/all": {
        const bytes = await readExactly(request, length(request));
        if (bytes === null) return new Response("too large", { status: 413 });
        await sha256(bytes);
        const { text: clean } = sanitizeText(await convert(env, bytes));
        const { text } = extractPages(clean);
        await store(env, text);
        return Response.json({ chars: text.length });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
