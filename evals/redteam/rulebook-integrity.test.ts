// Rulebook integrity (M5 step 9, T19, D53). The rulebook decides what every review checks; a
// poisoned rule ("shall not" quietly turned into "may") would flip verdicts with every quote
// still verifying. The data files are built reproducibly from pinned, hashed sources (D45);
// here their bytes are pinned too, so any edit fails CI unless this file changes with it, in
// the same reviewed commit. Rebuild: npm run build:data -w @lexguard/rulebook (identical bytes).
import { gdpr, ndaPlaybook } from "@lexguard/rulebook";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PINNED = {
  "gdpr.json": "1df85cbbf68b40d6de43c8d4cc84d43f18fee4a9b5d822f3b2b16e55e74b95b9",
  "nda.json": "71f7d8660f9f22cbb9bab39bba641e33c91506e8de2337472af7c945fd4ab68b",
};

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

describe("rulebook integrity", () => {
  it.each(Object.entries(PINNED))("%s has exactly its pinned bytes", (name, hash) => {
    const bytes = readFileSync(new URL(`../../packages/rulebook/data/${name}`, import.meta.url));
    expect(sha256(bytes)).toBe(hash);
  });

  it("would notice a one-word change to a rule", () => {
    const original = readFileSync(
      new URL("../../packages/rulebook/data/nda.json", import.meta.url),
      "utf8",
    );
    const poisoned = original.replace("shall not reverse engineer", "may reverse engineer");
    expect(poisoned).not.toBe(original);
    expect(sha256(poisoned)).not.toBe(PINNED["nda.json"]);
  });

  it("loads the rulebooks the pinned bytes describe", () => {
    expect(gdpr.rules).toHaveLength(786);
    expect(ndaPlaybook.rules).toHaveLength(17);
  });
});
