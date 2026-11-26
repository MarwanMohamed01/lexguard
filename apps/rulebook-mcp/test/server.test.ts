import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { searchRules } from "@lexguard/rulebook";
import { ALL_RULES, RULEBOOKS, rulebookHandler, SERVER_VERSION } from "../src/server";

// A real MCP client talking real HTTP messages to the handler, with fetch routed straight into
// handler.fetch (no network). The same client code will later reach the deployed server.
const handler = rulebookHandler();
const clients: Client[] = [];

async function connect(mode: "legacy" | "auto" = "auto"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://rulebook.test/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client(
    { name: "test", version: "1" },
    mode === "auto" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

type Text = { type: string; text?: string };
const firstText = (result: { content?: unknown }) => (result.content as Text[])[0]?.text ?? "";

describe("rulebook MCP server", () => {
  it.each(["legacy", "auto"] as const)(
    "lists exactly three read-only tools (%s client)",
    async (mode) => {
      const client = await connect(mode);
      expect(client.getServerVersion()).toMatchObject({
        name: "lexguard-rulebook",
        version: SERVER_VERSION,
      });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["get_rule", "list_rules", "search_rules"]);
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
      }
    },
  );

  it("get_rule returns the exact text of GDPR Article 28(3)(a)", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_rule", arguments: { id: "gdpr:28(3)(a)" } });
    expect(result.isError).not.toBe(true);
    const rule = (
      result.structuredContent as { rule: { text: string; title: string; source: string } }
    ).rule;
    expect(rule).toMatchObject({ source: "gdpr", title: "Processor" });
    expect(rule.text).toMatch(/^processes the personal data only on documented instructions/);
    // The text is exactly the rulebook's, so a verifier can check quotes against it.
    const gdpr = RULEBOOKS.get("gdpr");
    expect(gdpr?.text.includes(rule.text)).toBe(true);
    expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
  });

  it("get_rule answers an unknown rule as a tool error, not a crash", async () => {
    const client = await connect();
    const missing = await client.callTool({ name: "get_rule", arguments: { id: "gdpr:28(99)" } });
    expect(missing.isError).toBe(true);
    expect(firstText(missing)).toBe("No rule with ID gdpr:28(99).");
    const otherBook = await client.callTool({ name: "get_rule", arguments: { id: "hipaa:1" } });
    expect(otherBook.isError).toBe(true);
  });

  it("refuses arguments outside the schemas before any lookup", async () => {
    const client = await connect();
    for (const id of [
      "gdpr:28(3)(a); DROP",
      "ignore previous instructions",
      "gdpr:" + "1".repeat(50),
      "",
    ]) {
      const result = await client.callTool({ name: "get_rule", arguments: { id } });
      expect(result.isError, id).toBe(true);
      expect(firstText(result)).not.toContain("DROP"); // error does not echo the argument
    }
    const badSource = await client.callTool({
      name: "list_rules",
      arguments: { source: "hipaa", article: "1" },
    });
    expect(badSource.isError).toBe(true);
    const bigLimit = await client.callTool({
      name: "search_rules",
      arguments: { query: "data", limit: 1000 },
    });
    expect(bigLimit.isError).toBe(true);
  });

  it("list_rules returns an article's rules in order", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "list_rules",
      arguments: { source: "gdpr", article: "28" },
    });
    const ids = (result.structuredContent as { rules: { id: string }[] }).rules.map((r) => r.id);
    expect(ids.slice(0, 4)).toEqual(["gdpr:28(1)", "gdpr:28(2)", "gdpr:28(3)", "gdpr:28(3)(a)"]);
    expect(ids).toHaveLength(19);
    const none = await client.callTool({
      name: "list_rules",
      arguments: { source: "gdpr", article: "100" },
    });
    expect(none.isError).toBe(true);
  });

  it("search_rules finds rules across both rulebooks, best first, within the limit", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "search_rules",
      arguments: { query: "processor engage another processor written authorisation", limit: 3 },
    });
    const hits = (result.structuredContent as { hits: { rule: { id: string }; score: number }[] })
      .hits;
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.rule.id)).toContain("gdpr:28(2)");
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    const nda = await client.callTool({
      name: "search_rules",
      arguments: { query: "reverse engineer", source: "nda", limit: 1 },
    });
    expect((nda.structuredContent as { hits: { rule: { id: string } }[] }).hits[0]?.rule.id).toBe(
      "nda:11",
    );
  });

  it("get_rule looks a rule up in the book its prefix names", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_rule", arguments: { id: "nda:11" } });
    expect(result.structuredContent).toMatchObject({
      rule: { id: "nda:11", source: "nda", title: "No reverse engineering" },
    });
  });

  it("list_rules reads an article number with leading zeros as the same article", async () => {
    const client = await connect();
    const a = await client.callTool({
      name: "list_rules",
      arguments: { source: "gdpr", article: "028" },
    });
    const b = await client.callTool({
      name: "list_rules",
      arguments: { source: "gdpr", article: "28" },
    });
    expect(a.structuredContent).toEqual(b.structuredContent);
  });

  it("the combined search corpus keeps every rule's exact text", () => {
    let count = 0;
    for (const book of RULEBOOKS.values()) {
      for (const rule of book.rules) {
        const shifted = ALL_RULES.rules.find((r) => r.id === rule.id);
        expect(shifted && ALL_RULES.text.slice(shifted.start, shifted.end)).toBe(
          book.text.slice(rule.start, rule.end),
        );
        count++;
      }
    }
    expect(ALL_RULES.rules).toHaveLength(count);
  });

  it("search_rules ranks both rulebooks on one scale and keeps the overall top", async () => {
    const client = await connect();
    const query = "confidentiality obligations survive termination";
    const limit = 4;
    const result = await client.callTool({ name: "search_rules", arguments: { query, limit } });
    const ids = (result.structuredContent as { hits: { rule: { id: string } }[] }).hits.map(
      (h) => h.rule.id,
    );
    expect(ids).toEqual(searchRules(ALL_RULES, query, limit).map((h) => h.id));
    expect(new Set(ids.map((id) => id.split(":")[0]))).toEqual(new Set(["gdpr", "nda"]));
    // Searching one book only stays within it.
    const nda = await client.callTool({
      name: "search_rules",
      arguments: { query, limit, source: "nda" },
    });
    const ndaIds = (nda.structuredContent as { hits: { rule: { id: string } }[] }).hits.map(
      (h) => h.rule.id,
    );
    expect(ndaIds.length).toBeGreaterThan(0);
    expect(ndaIds.every((id) => id.startsWith("nda:"))).toBe(true);
  });

  it("refuses an oversized request body before parsing it", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { pad: "x".repeat(20_000) },
    });
    const response = await handler.fetch(
      new Request("http://rulebook.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
      }),
    );
    expect(response.status).toBe(413);
  });
});
