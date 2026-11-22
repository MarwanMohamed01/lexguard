import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Integration tests: send real requests through the Worker as the runtime would.
describe("worker (public routes)", () => {
  it("returns service info on /", async () => {
    const response = await exports.default.fetch("http://example.com/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "lexguard", status: "ok" });
  });

  it("answers /health", async () => {
    const response = await exports.default.fetch("http://example.com/health");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("returns 404 for unknown public paths", async () => {
    const response = await exports.default.fetch("http://example.com/nope");

    expect(response.status).toBe(404);
  });
});
