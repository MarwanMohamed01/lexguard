import { describe, expect, it } from "vitest";
import { REDACTED, scrubSecrets } from "../src/index";
import { makeTracer } from "./helpers";

// Threat model T13: secrets must never be stored in traces.
// Fake key values below are built at runtime so gitleaks does not flag this file.
const fakeOpenAiKey = "sk-" + "a".repeat(32);
const fakeGroqKey = "gsk_" + "b".repeat(40);
const fakeGoogleKey = "AIza" + "c".repeat(35);
const fakeGithubToken = "ghp_" + "d".repeat(36);
const fakeAwsKeyId = "AKIA" + "E".repeat(16);

describe("scrubSecrets", () => {
  it.each([
    ["OpenAI/Anthropic style key", `calling with ${fakeOpenAiKey}`],
    ["Groq key", `key ${fakeGroqKey}`],
    ["Google key", `url?key=${fakeGoogleKey}`],
    ["GitHub token", `token ${fakeGithubToken}`],
    ["AWS key id", `id ${fakeAwsKeyId}`],
    ["Bearer header", "Authorization: Bearer abc.def.ghi"],
    ["password assignment", "password=hunter22secret"],
    ["JSON api_key", '{"api_key": "abcdef123456"}'],
  ])("hides a %s", (_label, text) => {
    const out = scrubSecrets(text);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/a{32}|b{40}|c{35}|d{36}|E{16}|abc\.def|hunter22|abcdef123456/);
  });

  it("leaves ordinary text alone", () => {
    const text = "Clause 4.2: the Supplier shall keep tokens of appreciation under $50.";
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe("Tracer redaction", () => {
  it("never writes secrets from names, attributes or errors to the sink", async () => {
    const { tracer, sink } = makeTracer();

    const span = tracer.start("model_call", `call with ${fakeOpenAiKey}`, {
      prompt: `use key ${fakeGroqKey}`,
      apiKey: "anything-at-all",
      access_token: 12345,
    });
    span.fail(new Error(`401 for ${fakeGithubToken}`));
    await tracer.flush();

    const stored = JSON.stringify(sink.spans);
    expect(stored).not.toMatch(/a{32}|b{40}|d{36}|anything-at-all|12345/);
    expect(sink.spans[0]?.attributes.apiKey).toBe(REDACTED);
    expect(sink.spans[0]?.attributes.access_token).toBe(REDACTED);
  });

  it("does not redact harmless keys that merely contain 'token'", async () => {
    const { tracer, sink } = makeTracer();
    tracer.start("model_call", "extract", { inputTokens: 120, outputTokens: 30 }).end();
    await tracer.flush();

    expect(sink.spans[0]?.attributes).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it("accepts a custom redactor (e.g. PII redaction from @lexguard/guardrails later)", async () => {
    const { tracer, sink } = makeTracer({
      redact: (text) => text.replace(/[\w.]+@[\w.]+/g, "[EMAIL]"),
    });
    tracer.start("step", "notify", { to: "jane@acme.com" }).end();
    await tracer.flush();

    expect(sink.spans[0]?.attributes.to).toBe("[EMAIL]");
  });
});
