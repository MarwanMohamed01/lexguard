import { describe, expect, it } from "vitest";
import {
  compareClauseNumbers,
  isPlausibleNext,
  parseClauseNumber,
  romanToNumber,
} from "../src/sequence";

describe("isPlausibleNext", () => {
  it.each([
    ["7.1", "7.1.1", "deeper"],
    ["7.1", "7.2", "next at the same level"],
    ["7.1", "8", "up a level, then next"],
    ["7.1.2", "7.2", "up one level"],
    ["7.1.2", "8", "up two levels"],
    ["7.1.9", "7.1.10", "two-digit parts"],
    ["9.2.9", "9.2.9.1", "four levels"],
  ])("accepts %s -> %s (%s)", (previous, next) => {
    expect(isPlausibleNext(parseClauseNumber(previous), parseClauseNumber(next) ?? [])).toBe(true);
  });

  it.each([
    ["7.1", "7.1.2", "skips 7.1.1"],
    ["7.1", "7.3", "skips 7.2"],
    ["7.1", "3.2", "goes backwards (cross-reference)"],
    ["7.1", "9", "skips 8"],
    ["7.1", "30", "thirty (30) days"],
    ["7.1", "7.1", "repeat"],
    ["7", "7.1.1", "two levels deeper at once"],
    ["7.1", "7.1.0", "children start at 1"],
  ])("rejects %s -> %s (%s)", (previous, next) => {
    expect(isPlausibleNext(parseClauseNumber(previous), parseClauseNumber(next) ?? [])).toBe(false);
  });

  it("only accepts 1 when there is no previous heading", () => {
    expect(isPlausibleNext(null, [1])).toBe(true);
    expect(isPlausibleNext(null, [2])).toBe(false);
    expect(isPlausibleNext(null, [1, 1])).toBe(false);
  });
});

describe("parseClauseNumber", () => {
  it("parses dotted numbers, leading zeros and roman numerals", () => {
    expect(parseClauseNumber("7.1.2")).toEqual([7, 1, 2]);
    expect(parseClauseNumber("2.01")).toEqual([2, 1]);
    expect(parseClauseNumber("IV")).toEqual([4]);
    expect(parseClauseNumber("XIV")).toEqual([14]);
  });

  it("rejects anything else", () => {
    expect(parseClauseNumber("7.")).toBeNull();
    expect(parseClauseNumber("2020")).toBeNull();
    expect(parseClauseNumber("IIII")).toBeNull();
    expect(parseClauseNumber("")).toBeNull();
    expect(romanToNumber("ABC")).toBeNull();
  });
});

describe("compareClauseNumbers", () => {
  it("orders like the document", () => {
    const sorted = [[8], [7, 2], [7, 1, 1], [7, 1]].sort(compareClauseNumbers);
    expect(sorted).toEqual([[7, 1], [7, 1, 1], [7, 2], [8]]);
  });
});
