// Runs the real Lexguard Worker under `wrangler dev` for local evals (M2 steps 6-7).
//
// Worker code, D1 and the chunking Workflow run on this machine; only toMarkdown runs on
// Cloudflare (it always does), through your existing `wrangler login`. Nothing is deployed
// and nothing is created on the account.
//
// The API key is generated here, in memory, for this run only: it reaches wrangler as an
// environment variable (TENANT_KEYS holds only its hash) and is never written to disk.
// Local state goes to `stateDir` (under evals/data/, git-ignored) and is deleted on stop.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("../../apps/worker/", import.meta.url));
// npx on Windows is a .cmd file, which needs a shell.
const shell = process.platform === "win32";

function wrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: workerDir,
    encoding: "utf8",
    shell,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

/** Starts the Worker on `port` with a fresh local D1; resolves once it answers /health. */
export async function startLocalWorker({ stateDir, port = 8799, tenant = "eval" }) {
  const state = fileURLToPath(stateDir);
  const base = `http://127.0.0.1:${String(port)}`;
  const key = `lg_${randomBytes(32).toString("base64url")}`;
  const tenantKeys = JSON.stringify({ [createHash("sha256").update(key).digest("hex")]: tenant });

  rmSync(state, { recursive: true, force: true });
  wrangler(["d1", "migrations", "apply", "lexguard", "--local", "--persist-to", state]);

  const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--persist-to", state], {
    cwd: workerDir,
    shell,
    env: { ...process.env, TENANT_KEYS: tenantKeys },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  const kill = () => {
    if (dev.exitCode !== null) return;
    if (shell) spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"]);
    else dev.kill("SIGTERM");
  };
  process.on("exit", kill);

  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) {
      kill();
      throw new Error(`wrangler dev did not start:\n${log}`);
    }
    await sleep(500);
  }

  const auth = { Authorization: `Bearer ${key}` };

  return {
    /** Uploads a file and waits until chunking is over; returns the outcome. */
    async upload(bytes, filename) {
      const started = Date.now();
      const response = await fetch(`${base}/v1/documents`, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Length": String(bytes.length),
          "X-Filename": encodeURIComponent(filename),
        },
        body: bytes,
      });
      const body = await response.json();
      const uploadMs = Date.now() - started;
      let document = body.document;
      while (document?.status === "chunking" && Date.now() - started < 10 * 60 * 1000) {
        await sleep(1000);
        const status = await fetch(`${base}/v1/documents/${document.id}`, { headers: auth });
        document = (await status.json()).document;
      }
      return {
        httpStatus: response.status,
        error: body.error ?? document?.error ?? null,
        document,
        uploadMs,
        readyMs: Date.now() - started,
      };
    },

    /** Runs a read-only query against the local D1 and returns the rows. */
    query(sql) {
      // Through a file: SQL on a Windows command line gets mangled by shell quoting.
      const file = `${state}query.sql`;
      writeFileSync(file, sql);
      const out = wrangler([
        "d1",
        "execute",
        "lexguard",
        "--local",
        "--persist-to",
        state,
        "--json",
        "--file",
        file,
      ]);
      return JSON.parse(out)[0].results;
    },

    /** The last lines of the Worker's own log (for debugging). */
    log: (lines = 25) =>
      log
        .split("\n")
        .filter((l) => !l.includes("explorer"))
        .slice(-lines)
        .join("\n"),

    async stop() {
      kill();
      await sleep(1000);
      rmSync(state, { recursive: true, force: true });
    },
  };
}
