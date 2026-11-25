import { describe, expect, it } from "vitest";
import { termMatcher } from "../src";

describe("termMatcher", () => {
  const find = termMatcher(["Supplier", "Effective Date", "Date", "Products", "Party", "A"]);

  it("finds whole, case-sensitive terms in order of first use, once each", () => {
    expect(find("After the Effective Date the Supplier ships Products to the Supplier.")).toEqual([
      "Effective Date",
      "Supplier",
      "Products",
    ]);
  });

  it("prefers the longest term at a position", () => {
    expect(find("from the Effective Date")).toEqual(["Effective Date"]);
    expect(find("on that Date")).toEqual(["Date"]);
  });

  it("ignores other capitalisation, plurals and words that only contain a term", () => {
    expect(find("the supplier and the Suppliers and Partying")).toEqual([]);
  });

  it("ignores one-letter terms and treats special characters literally", () => {
    expect(find("A party")).toEqual([]);
    const special = termMatcher(["Fee (USD)", "C++ Code"]);
    expect(special("pay the Fee (USD) for C++ Code")).toEqual(["Fee (USD)", "C++ Code"]);
    expect(special("pay the Fee USD")).toEqual([]);
  });

  it("works with non-English letters at word edges", () => {
    const de = termMatcher(["Käufer"]);
    expect(de("Der Käufer zahlt.")).toEqual(["Käufer"]);
    expect(de("Die Käuferin zahlt.")).toEqual([]);
  });

  it("returns nothing without terms", () => {
    expect(termMatcher([])("Supplier")).toEqual([]);
  });

  it("stays fast with many terms and a long text", () => {
    const terms = Array.from({ length: 500 }, (_, i) => `Term Number ${String(i)}`);
    const text = "The Term Number 42 applies. ".repeat(200);
    const started = Date.now();
    expect(termMatcher(terms)(text)).toEqual(["Term Number 42"]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("termMatcher, longest term first", () => {
  it("prefers the longer term even when the shorter one is listed first", () => {
    const find = termMatcher(["Product", "Product Warranty"]);
    expect(find("the Product Warranty lasts")).toEqual(["Product Warranty"]);
    expect(find("each Product ships")).toEqual(["Product"]);
  });
});
