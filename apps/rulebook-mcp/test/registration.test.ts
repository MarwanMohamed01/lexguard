import { describe, expect, it } from "vitest";
import { isLoopbackRedirect, registrationPolicy } from "../src/registration";

describe("isLoopbackRedirect", () => {
  it.each([
    "http://localhost:6274/oauth/callback", // MCP Inspector
    "http://127.0.0.1:33418/callback",
    "http://[::1]:8080/cb",
    "https://localhost/cb",
  ])("allows %s", (uri) => {
    expect(isLoopbackRedirect(uri)).toBe(true);
  });

  it.each([
    "https://attacker.example/cb",
    "http://localhost.attacker.example/cb", // looks local, is not
    "http://127.0.0.2/cb",
    "http://user:pass@localhost/cb", // hidden user info
    "http://user@localhost/cb", // a user name alone
    "http://:pass@localhost/cb", // a password alone
    "http://localhost/cb#fragment",
    "javascript:alert(1)",
    "ftp://localhost/cb",
    `http://localhost/${"x".repeat(300)}`,
    "not a url",
    42,
    undefined,
  ])("refuses %s", (uri) => {
    expect(isLoopbackRedirect(uri)).toBe(false);
  });
});

describe("registrationPolicy", () => {
  const policy = (clientMetadata: Record<string, unknown>) =>
    registrationPolicy({ clientMetadata });

  it("allows a desktop client whose redirect URIs are all local", () => {
    expect(
      policy({
        client_name: "MCP Inspector",
        redirect_uris: [
          "http://localhost:6274/oauth/callback",
          "http://localhost:6274/oauth/callback/debug",
        ],
      }),
    ).toBeUndefined();
    expect(policy({ redirect_uris: ["http://127.0.0.1:1/cb"] })).toBeUndefined(); // name optional
  });

  it("refuses any remote redirect URI, even mixed with local ones", () => {
    expect(policy({ redirect_uris: ["https://attacker.example/cb"] })).toMatchObject({
      code: "invalid_redirect_uri",
      status: 400,
    });
    expect(
      policy({ redirect_uris: ["http://localhost/cb", "https://attacker.example/cb"] }),
    ).toMatchObject({ code: "invalid_redirect_uri" });
  });

  it("refuses missing, empty, too many or non-list redirect URIs", () => {
    for (const redirect_uris of [
      undefined,
      [],
      "http://localhost/cb",
      Array(6).fill("http://localhost/cb"),
    ]) {
      expect(policy({ redirect_uris })).toMatchObject({ code: "invalid_redirect_uri" });
    }
    expect(policy({ redirect_uris: Array(5).fill("http://localhost/cb") })).toBeUndefined();
  });

  it("refuses an overlong or non-text client name", () => {
    const ok = ["http://localhost/cb"];
    expect(policy({ redirect_uris: ok, client_name: "x".repeat(101) })).toMatchObject({
      code: "invalid_client_metadata",
    });
    expect(policy({ redirect_uris: ok, client_name: 7 })).toMatchObject({
      code: "invalid_client_metadata",
    });
    expect(policy({ redirect_uris: ok, client_name: "x".repeat(100) })).toBeUndefined();
  });
});
