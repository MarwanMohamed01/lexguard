// Keeps only the CPU facts from `wrangler tail --format json` (M3 step 8). Tail events can
// carry request headers, and the smoke test sends your API key in one, so raw tail output is
// never written anywhere: this script starts `wrangler tail` itself, keeps one line per event
// with only the fields below (IDs in paths replaced by ":id") and appends it to the file at
// once, so the file is safe to share and Ctrl+C loses nothing.
//
//   node scripts/tail-cpu.mjs --record tail-cpu.jsonl      (from the repo root; Ctrl+C to stop)
//   node scripts/tail-cpu.mjs --summary tail-cpu.jsonl
//
// Why not `wrangler tail ... | node ... > file`: in Windows PowerShell 5.1, `>` collects the
// output and writes it (as UTF-16) only when the pipeline ends, and Ctrl+C discards it. Both
// first captures of M3 step 8 came out empty that way.

import { spawn } from "node:child_process";
import { appendFileSync, createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The only fields kept. Anything else in the event (headers, bodies, logs) is dropped. */
function reduce(event) {
  const request = event?.event?.request;
  let path = null;
  if (typeof request?.url === "string") {
    try {
      path = new URL(request.url).pathname.replace(UUID, ":id");
    } catch {
      path = "(unparsable)";
    }
  }
  const number = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    // Workflow steps arrive without a request; their entrypoint names the class.
    kind:
      request === undefined ? String(event?.entrypoint ?? event?.eventType ?? "other") : "fetch",
    method: typeof request?.method === "string" ? request.method : null,
    path,
    status: number(event?.event?.response?.status),
    outcome: typeof event?.outcome === "string" ? event.outcome : null,
    cpuMs: number(event?.cpuTime),
    wallMs: number(event?.wallTime),
  };
}

function summarise(file) {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
  const groups = new Map();
  for (const r of rows) {
    const key = r.kind === "fetch" ? `${r.method} ${r.path}` : r.kind;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, list] of [...groups].sort()) {
    const cpu = list.map((r) => r.cpuMs ?? 0).sort((a, b) => a - b);
    const outcomes = [...new Set(list.map((r) => r.outcome))].join(",");
    console.log(
      `${key.padEnd(44)} n=${String(list.length).padStart(3)}  cpu p50 ${String(cpu[cpu.length >> 1])} ms, max ${String(cpu.at(-1))} ms  outcomes ${outcomes}`,
    );
  }
}

/**
 * Splits a stream into complete top-level JSON objects, whether tail prints one per line or
 * indented over many lines: counts braces outside strings. Text between objects is ignored.
 */
export function objectSplitter(onObject) {
  let buffer = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    for (const ch of chunk) {
      if (depth === 0 && ch !== "{") continue;
      buffer += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          onObject(JSON.parse(buffer));
        } catch {
          // Not valid JSON after all: dropped, never echoed.
        }
        buffer = "";
      }
    }
  };
}

if (process.argv[2] === "--summary") {
  summarise(process.argv[3] ?? "tail-cpu.jsonl");
} else if (process.argv[2] === "--record") {
  const out = process.argv[3] ?? "tail-cpu.jsonl";
  writeFileSync(out, "");
  let events = 0;
  const feed = objectSplitter((event) => {
    appendFileSync(out, `${JSON.stringify(reduce(event))}\n`);
    events++;
  });
  // TAIL_FROM_FILE: read a saved stream instead of starting wrangler (tests only).
  const source = process.env.TAIL_FROM_FILE;
  const child =
    source === undefined
      ? spawn("npx", ["wrangler", "tail", "lexguard", "--format", "json"], {
          cwd: fileURLToPath(new URL("../apps/worker/", import.meta.url)),
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "inherit"], // wrangler's own messages stay visible
        })
      : null;
  const input = child === null ? createReadStream(source) : child.stdout;
  process.on("SIGINT", () => {
    console.error(`\nstopped: ${String(events)} events in ${out}`);
    child?.kill();
    process.exit(0);
  });
  console.error(`recording CPU facts to ${out} (Ctrl+C to stop)`);
  for await (const line of createInterface({ input })) feed(`${line}\n`);
  console.error(`tail ended: ${String(events)} events in ${out}`);
} else if (process.argv[1]?.endsWith("tail-cpu.mjs")) {
  // Filter mode, stdin to stdout (Unix shells, where redirection streams).
  const feed = objectSplitter((event) => {
    process.stdout.write(`${JSON.stringify(reduce(event))}\n`);
  });
  for await (const line of createInterface({ input: process.stdin })) feed(`${line}\n`);
}
