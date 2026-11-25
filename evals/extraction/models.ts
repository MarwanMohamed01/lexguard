// Model adapters and the answer cache for the extraction eval (M4 step 4).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import type { Prompt } from "@lexguard/extraction";

export interface ModelAnswer {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  ms: number;
}

export interface ChatModel {
  /** Recorded with every answer: changing it means new answers. */
  name: string;
  answer(prompt: Prompt): Promise<ModelAnswer>;
}

/**
 * Local Ollama chat. JSON mode only (no schema-constrained decoding), so the result says how
 * often a model breaks the form on its own; temperature 0 for repeatable answers.
 */
export function ollamaChat(model = "llama3.1:8b", url = "http://127.0.0.1:11434"): ChatModel {
  return {
    name: `ollama-${model}-json-t0`,
    async answer(prompt) {
      const started = Date.now();
      // node:http, not fetch: fetch gives up after 300 s without response headers, and a CPU
      // can need longer than that to read the prompt (measured: the first chunk took > 5 min).
      const { status, text } = await post(
        `${url}/api/chat`,
        JSON.stringify({
          model,
          stream: false,
          format: "json",
          // 8,192 tokens hold the ~2,500-token prompt, a 4,000-character chunk and the answer.
          options: { temperature: 0, num_ctx: 8_192, num_predict: 2_048 },
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
      );
      if (status !== 200) throw new Error(`ollama ${String(status)}: ${text.slice(0, 300)}`);
      // prompt_eval_count counts only the input tokens Ollama had to read: a prompt start it
      // still holds from the previous call is not counted. Neurons are estimated from
      // characters instead (D26: about 3.2 characters per token).
      const body = JSON.parse(text) as {
        message?: { content?: unknown };
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      const count = (v: unknown) => (typeof v === "number" ? v : null);
      return {
        text: typeof body.message?.content === "string" ? body.message.content : "",
        inputTokens: count(body.prompt_eval_count),
        outputTokens: count(body.eval_count),
        ms: Date.now() - started,
      };
    },
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** "7.66s", "2m59.5s", "120ms" (Groq's reset headers) or plain seconds (retry-after). */
export function parseWait(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  if (/^\d+(\.\d+)?$/u.test(value.trim())) return Number(value) * 1_000;
  let ms = 0;
  let matched = false;
  for (const [, n, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gu)) {
    matched = true;
    ms += Number(n) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1);
  }
  return matched ? ms : null;
}

/**
 * Groq's OpenAI-compatible chat API (free plan). Only for evals on public CUAD contracts:
 * D34 keeps real documents away from Groq. The key comes from GROQ_API_KEY (evals/.env,
 * git-ignored) and is never logged; error messages carry only the status and Groq's text.
 */
export function groqChat(
  model = "openai/gpt-oss-20b",
  apiKey = process.env.GROQ_API_KEY,
  url = "https://api.groq.com/openai/v1/chat/completions",
): ChatModel {
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("GROQ_API_KEY is not set (evals/.env)");
  }
  const key = apiKey.trim();
  return {
    name: `groq-${model}-json-low-t0`,
    async answer(prompt) {
      const started = Date.now();
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_completion_tokens: 4_096,
            response_format: { type: "json_object" },
            // gpt-oss is a reasoning model; its hidden reasoning counts as output tokens.
            reasoning_effort: "low",
            include_reasoning: false,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
          }),
        });
        const text = await response.text();
        if (response.status === 429 || response.status >= 500) {
          if (attempt >= 8) throw new Error(`groq ${String(response.status)} after 8 attempts`);
          const wait =
            parseWait(response.headers.get("retry-after")) ??
            parseWait(response.headers.get("x-ratelimit-reset-tokens")) ??
            5_000 * attempt;
          console.log(`groq ${String(response.status)}: waiting ${(wait / 1000).toFixed(1)} s`);
          await sleep(Math.min(wait + 250, 120_000));
          continue;
        }
        // A model that cannot produce valid JSON gets HTTP 400 "json_validate_failed": that is
        // a model failure to record (as empty output), not a reason to stop the run.
        if (response.status === 400 && text.includes("json_validate_failed")) {
          return { text: "", inputTokens: null, outputTokens: null, ms: Date.now() - started };
        }
        if (!response.ok) throw new Error(`groq ${String(response.status)}: ${text.slice(0, 300)}`);
        const body = JSON.parse(text) as {
          choices?: { message?: { content?: unknown } }[];
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const count = (v: unknown) => (typeof v === "number" ? v : null);
        const content = body.choices?.[0]?.message?.content;
        return {
          text: typeof content === "string" ? content : "",
          inputTokens: count(body.usage?.prompt_tokens),
          outputTokens: count(body.usage?.completion_tokens),
          ms: Date.now() - started,
        };
      }
    },
  };
}

function post(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export const CACHE_DIR = new URL("../data/extraction/", import.meta.url);

/** One line per (model, prompt version, chunk text): answers are never asked for twice. */
export class AnswerCache {
  private readonly file: URL;
  private readonly answers = new Map<string, ModelAnswer>();

  constructor(model: string, promptVersion: string, dir: URL = CACHE_DIR) {
    const safe = `${model}__${promptVersion}`.replace(/[^a-zA-Z0-9._-]+/gu, "_");
    this.file = new URL(`${safe}.jsonl`, dir);
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const { key, answer } = JSON.parse(line) as { key: string; answer: ModelAnswer };
        this.answers.set(key, answer);
      }
    }
  }

  static key(chunkText: string): string {
    return createHash("sha256").update(chunkText, "utf8").digest("hex");
  }

  get(chunkText: string): ModelAnswer | undefined {
    return this.answers.get(AnswerCache.key(chunkText));
  }

  put(chunkText: string, answer: ModelAnswer): void {
    const key = AnswerCache.key(chunkText);
    this.answers.set(key, answer);
    appendFileSync(this.file, `${JSON.stringify({ key, answer })}\n`);
  }
}

/**
 * The eval's nonce: derived from the chunk, so a cached answer matches the exact prompt it was
 * given. Production must use a fresh random nonce per call (D36); here repeatability matters
 * more, and the documents are public CUAD contracts.
 */
export const evalNonce = (chunkText: string) => AnswerCache.key(chunkText).slice(0, 24);
