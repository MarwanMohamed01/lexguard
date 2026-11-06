import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// Unit test: call the handler function directly, like calling a Python function in pytest.
// The handler only needs `request` for now; `env` and `ctx` are passed once bindings exist.
describe("worker.fetch (unit)", () => {
  it("returns service info on /", async () => {
    const request = new Request<unknown, IncomingRequestCfProperties>("http://example.com/");
    const response = worker.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "lexguard", status: "ok" });
  });

  it("returns 404 for unknown paths", () => {
    const request = new Request<unknown, IncomingRequestCfProperties>("http://example.com/nope");
    const response = worker.fetch(request);

    expect(response.status).toBe(404);
  });
});

// Integration test: send a real request through the Worker as the runtime would.
describe("worker (integration)", () => {
  it("answers /health", async () => {
    const response = await exports.default.fetch("http://example.com/health");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
