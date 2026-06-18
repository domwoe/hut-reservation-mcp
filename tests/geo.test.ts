import { describe, expect, it } from "vitest";

import { distanceKm, parseCoordinates } from "../src/geo.js";

describe("geo helpers", () => {
  it("parses comma-separated and slash-separated coordinates", () => {
    expect(parseCoordinates("46.916885,8.875034")).toEqual({ lat: 46.916885, lon: 8.875034 });
    expect(parseCoordinates("46.79/08.76")).toEqual({ lat: 46.79, lon: 8.76 });
  });

  it("rejects malformed coordinates", () => {
    expect(parseCoordinates(null)).toBeNull();
    expect(parseCoordinates("hello")).toBeNull();
    expect(parseCoordinates("1000,8")).toBeNull();
  });

  it("computes useful distance in kilometers", () => {
    const altdorf = { lat: 46.8804, lon: 8.6394 };
    const andermatt = { lat: 46.6356, lon: 8.5930 };
    expect(distanceKm(altdorf, andermatt)).toBeGreaterThan(25);
    expect(distanceKm(altdorf, andermatt)).toBeLessThan(30);
  });
});
