import { describe, expect, it } from "vitest";
import { ToolPolicy } from "../src/index";
import { policy, tools } from "./fixtures";

describe("ToolPolicy.authorize", () => {
  it("allows a granted read tool and returns the parsed args", () => {
    expect(policy.authorize("researcher", "rulebook.lookup", { article: "GDPR Art. 28" })).toEqual({
      allowed: true,
      tool: "rulebook.lookup",
      args: { article: "GDPR Art. 28" },
      needsApproval: false,
    });
  });

  it("flags tools that need human approval", () => {
    expect(policy.authorize("synthesizer", "report.export", { reportId: "r1" })).toMatchObject({
      allowed: true,
      needsApproval: true,
    });
  });

  it.each([
    ["unknown agent", "nobody", "rulebook.lookup", { article: "x" }, "unknown_agent"],
    ["unknown tool", "researcher", "shell.exec", {}, "unknown_tool"],
    [
      "tool not granted",
      "researcher",
      "clauses.save",
      { clauseId: "c", text: "t" },
      "tool_not_allowed",
    ],
    [
      "extractor has no tools",
      "extractor",
      "rulebook.lookup",
      { article: "x" },
      "tool_not_allowed",
    ],
    [
      "scope missing",
      "misconfigured",
      "clauses.save",
      { clauseId: "c", text: "t" },
      "scope_not_granted",
    ],
    ["invalid args", "researcher", "rulebook.lookup", { article: "" }, "invalid_args"],
  ])("denies: %s", (_label, agent, tool, args, reason) => {
    expect(policy.authorize(agent, tool, args)).toMatchObject({ allowed: false, reason });
  });
});

describe("ToolPolicy config checks", () => {
  it("rejects a grant for a tool that does not exist", () => {
    expect(() => new ToolPolicy(tools, { a: { tools: ["typo.tool"], scopes: ["read"] } })).toThrow(
      /unknown tool "typo.tool"/,
    );
  });

  it("rejects duplicate tool names", () => {
    expect(() => new ToolPolicy([...tools, ...tools], {})).toThrow(/duplicate tool/);
  });
});
