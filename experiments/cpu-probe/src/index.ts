// CPU probe: does chunking a long contract fit the Free plan's CPU limit, and does a Queue
// consumer get more CPU than an HTTP request? Cloudflare kills an invocation that keeps
// exceeding its limit (HTTP: error 1102; any handler: outcome "exceededCpu" in wrangler tail).
// performance.now() is frozen during CPU work on deployed Workers, so the verdict comes from
// Cloudflare (tail outcome, Workers Logs CPUTimeMs), not from timing inside this code.

import { chunkDocument } from "../../../packages/chunker/src/index";

interface ProbeMessage {
  chars: number;
  run: number;
}

interface ProbeEnv {
  PROBE_QUEUE: Queue<ProbeMessage>;
}

const MAX_CHARS = 2_000_000;

/**
 * Deterministic contract-like text of about `chars` characters, with numbered clauses,
 * sub-clauses, list items and definitions, so the chunker does its real work. Building it
 * is cheap next to chunking (one array join).
 */
function synthetic(chars: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let article = 1; length < chars; article++) {
    for (let clause = 1; clause <= 8 && length < chars; clause++) {
      const block =
        `${String(article)}.${String(clause)} Obligations of the Parties. The Supplier shall ` +
        `deliver the Products described in Schedule ${String(article)} within thirty (30) days ` +
        `of each Order, subject to Section ${String(article + 2)}.1 hereof: (a) in accordance ` +
        `with the Specifications; (b) free of defects in materials and workmanship; and (c) ` +
        `packed for shipment. "Order ${String(article)}.${String(clause)}" means a purchase ` +
        `order issued by the Customer under this Agreement. ${"The Customer may inspect the ".repeat(6)}` +
        `Products on delivery.\n\n`;
      parts.push(block);
      length += block.length;
    }
  }
  return parts.join("").slice(0, chars);
}

function sizeParam(url: URL): number {
  const chars = Number(url.searchParams.get("chars"));
  if (!Number.isInteger(chars) || chars < 1 || chars > MAX_CHARS) {
    throw new RangeError(`chars must be an integer from 1 to ${String(MAX_CHARS)}`);
  }
  return chars;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/chunk") {
        const text = await request.text();
        if (text.length > MAX_CHARS) return new Response("too large", { status: 413 });
        const { chunks } = chunkDocument(text);
        return Response.json({ chars: text.length, chunks: chunks.length });
      }
      if (request.method === "GET" && url.pathname === "/burn") {
        const text = synthetic(sizeParam(url));
        return Response.json({ chars: text.length, chunks: chunkDocument(text).chunks.length });
      }
      if (request.method === "POST" && url.pathname === "/enqueue") {
        const chars = sizeParam(url);
        const repeat = Math.min(20, Math.max(1, Number(url.searchParams.get("repeat")) || 1));
        await env.PROBE_QUEUE.sendBatch(
          Array.from({ length: repeat }, (_, run) => ({ body: { chars, run } })),
        );
        return Response.json({ sent: repeat, chars });
      }
    } catch (error) {
      if (error instanceof RangeError) return new Response(error.message, { status: 400 });
      throw error;
    }
    return new Response("Not found", { status: 404 });
  },

  queue(batch): void {
    for (const message of batch.messages) {
      const text = synthetic(message.body.chars);
      const chunks = chunkDocument(text).chunks.length;
      console.log(JSON.stringify({ probe: "queue", ...message.body, chunks }));
      message.ack();
    }
  },
} satisfies ExportedHandler<ProbeEnv, ProbeMessage>;
