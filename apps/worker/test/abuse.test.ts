// Threat model T15 (quota exhaustion) and response hardening, in the Workers runtime.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DAILY_UPLOADS_PER_TENANT, handle } from "../src/app";
import type { Converter } from "../src/upload";
import { makePdf } from "./files";
import { TEST_KEYS } from "./fixtures";

const converter = vi.fn<Converter>((file) =>
  Promise.resolve({
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: "application/pdf",
    format: "markdown" as const,
    tokens: 1,
    data: "1. Term\nText.",
  }),
);

function upload(now: Date, uploadsPerDay = 3) {
  const pdf = makePdf();
  const request = new Request("http://example.com/v1/documents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_KEYS.quota}`,
      "Content-Length": String(pdf.length),
      "X-Filename": "a.pdf",
    },
    body: pdf,
  });
  return handle(request, env, {
    convert: converter,
    startChunking: () => Promise.resolve(),
    now: () => now,
    uploadsPerDay,
  });
}

describe("daily upload quota per tenant (T15)", () => {
  it("defaults to a limit that leaves most of the shared daily budget to others", () => {
    expect(DAILY_UPLOADS_PER_TENANT).toBe(50);
  });

  it("refuses uploads past the limit until 00:00 UTC, without converting", async () => {
    // A day of its own, so earlier tests' documents do not count.
    const day = new Date("2031-03-10T22:00:00Z");
    for (let i = 0; i < 3; i++) expect((await upload(day)).status).toBe(201);
    converter.mockClear();

    const refused = await upload(day);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "daily_upload_limit", limit: 3 });
    expect(refused.headers.get("Retry-After")).toBe(String(2 * 60 * 60)); // until midnight UTC
    expect(converter).not.toHaveBeenCalled();
  });

  it("starts counting again the next day (UTC)", async () => {
    const day = new Date("2031-04-10T12:00:00Z");
    for (let i = 0; i < 3; i++) await upload(day);
    expect((await upload(day)).status).toBe(429);

    const nextDay = new Date("2031-04-11T00:00:01Z");
    expect((await upload(nextDay)).status).toBe(201);
  });
});

describe("response hardening", () => {
  it.each([
    ["an authenticated response", { Authorization: `Bearer ${TEST_KEYS.acme}` }, 200],
    ["a refused request", {}, 401],
  ])("marks %s as never cached and not sniffable", async (_label, headers, status) => {
    const response = await exports.default.fetch("http://example.com/v1/whoami", { headers });

    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
