import { describe, expect, it } from "vitest";

import { NominatimGeocoder } from "../src/geocoder.js";
import type { AreaCacheEntry, HutRecord } from "../src/types.js";

function hut(hutId: number, lat: number, lon: number): HutRecord {
  return {
    hutId,
    hutName: `Hut ${hutId}`,
    hutCountry: "CH",
    coordinatesRaw: `${lat},${lon}`,
    coordinates: { lat, lon },
    altitude: null,
    serviced: null,
    totalBedsInfo: null,
    info: null
  };
}

function areaEntry(hutId: number, overrides: Partial<AreaCacheEntry> = {}): AreaCacheEntry {
  return {
    hutId,
    lat: 46.88,
    lon: 8.64,
    provider: "https://nominatim.example",
    countryCode: "CH",
    country: "Switzerland",
    canton: "Uri",
    state: "Uri",
    displayName: "Uri, Switzerland",
    attribution: "test",
    refreshedAt: "2026-06-18T00:00:00.000Z",
    ...overrides
  };
}

describe("NominatimGeocoder", () => {
  it("refreshes stale or incomplete cache entries and skips current entries", async () => {
    const requested: string[] = [];
    const geocoder = new NominatimGeocoder(
      {
        baseUrl: "https://nominatim.example",
        userAgent: "hut-reservation-mcp-test",
        email: null,
        minIntervalMs: 0
      },
      async (input) => {
        requested.push(String(input));
        const url = new URL(String(input));
        return Response.json({
          licence: "test attribution",
          display_name: "Uri, Switzerland",
          address: {
            country: "Switzerland",
            country_code: "ch",
            state: `Canton ${url.searchParams.get("lat")}`
          }
        });
      }
    );

    const legacyEntry = areaEntry(4, { lat: 46.5, lon: 8.3 });
    delete legacyEntry.provider;

    const result = await geocoder.refresh(
      [hut(1, 46.88, 8.64), hut(2, 46.7, 8.5), hut(3, 46.6, 8.4), hut(4, 46.5, 8.3)],
      {
        existing: {
          "1": areaEntry(1),
          "2": areaEntry(2, { lat: 46.7, lon: 8.5, canton: null }),
          "3": areaEntry(3, { lat: 46.6, lon: 8.4, provider: "https://old-provider.example" }),
          "4": legacyEntry
        }
      }
    );

    expect(requested).toHaveLength(3);
    expect(result.skipped).toBe(1);
    expect(result.entries.map((entry) => entry.hutId)).toEqual([2, 3, 4]);
    expect(result.entries.every((entry) => entry.provider === "https://nominatim.example")).toBe(true);
  });
});
