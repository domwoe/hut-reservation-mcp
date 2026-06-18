import { describe, expect, it } from "vitest";

import { nightsBetween, parseIsoDate, swissToIsoDate, toSwissDate } from "../src/date.js";

describe("date helpers", () => {
  it("converts ISO dates to upstream Swiss format", () => {
    expect(toSwissDate("2026-07-04")).toBe("04.07.2026");
  });

  it("rejects invalid or ambiguous dates", () => {
    expect(() => parseIsoDate("04.07.2026")).toThrow(/YYYY-MM-DD/);
    expect(() => parseIsoDate("2026-02-30")).toThrow(/Invalid calendar date/);
  });

  it("lists each arrival night before departure", () => {
    expect(nightsBetween("2026-07-04", "2026-07-07")).toEqual([
      "2026-07-04",
      "2026-07-05",
      "2026-07-06"
    ]);
  });

  it("normalizes Swiss upstream dates back to ISO", () => {
    expect(swissToIsoDate("05.07.2026")).toBe("2026-07-05");
  });

  it("rejects invalid Swiss upstream dates", () => {
    expect(() => swissToIsoDate("31.02.2026")).toThrow(/Invalid Swiss date: 31\.02\.2026/);
    expect(() => swissToIsoDate("00.01.2026")).toThrow(/Invalid Swiss date: 00\.01\.2026/);
    expect(() => swissToIsoDate("aa.01.2026")).toThrow(/Invalid Swiss date: aa\.01\.2026/);
    expect(() => swissToIsoDate("1.2.2026")).toThrow(/Invalid Swiss date: 1\.2\.2026/);
  });
});
