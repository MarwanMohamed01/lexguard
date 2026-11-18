import { describe, expect, it } from "vitest";
import { parsePyLiteral } from "./pyliteral";

describe("parsePyLiteral", () => {
  it("parses a Gretel entity list", () => {
    const source =
      "[{'entity': 'a@b.org', 'types': ['email']}, {'entity': \"O'Brien\", 'types': ['name']}]";
    expect(parsePyLiteral(source)).toEqual([
      { entity: "a@b.org", types: ["email"] },
      { entity: "O'Brien", types: ["name"] },
    ]);
  });

  it("handles escapes and empty containers", () => {
    expect(parsePyLiteral("['it\\'s', '\\x41\\n', [], {}]")).toEqual(["it's", "A\n", [], {}]);
  });

  it.each([
    ["code is not data", "__import__('os').system('calc')"],
    ["numbers are not supported", "[1, 2]"],
    ["unterminated string", "['abc"],
    ["trailing input", "['a'] extra"],
    ["non-string key", "{1: 'a'}"],
  ])("rejects %s", (_label, source) => {
    expect(() => parsePyLiteral(source)).toThrow(SyntaxError);
  });

  it("does not let a key named __proto__ change the object's prototype", () => {
    const value = parsePyLiteral("{'__proto__': 'x'}") as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(null);
    expect(value.__proto__).toBe("x");
  });
});
