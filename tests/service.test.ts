import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalCache } from "../src/cache.js";
import type { AppConfig, HutStatusResponse } from "../src/types.js";
import { NominatimGeocoder } from "../src/geocoder.js";
import { HutReservationService } from "../src/service.js";
import type { HutReservationClient } from "../src/upstream.js";

function testConfig(cacheDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  const config: AppConfig = {
    baseUrl: "https://www.hut-reservation.org",
    cacheDir,
    credentials: null,
    requestTimeoutMs: 15_000,
    experimentalWrites: false,
    liveSmoke: false,
    nominatim: {
      baseUrl: null,
      userAgent: null,
      email: null,
      minIntervalMs: 0
    }
  };
  return { ...config, ...overrides };
}

async function makeService(
  client: Partial<HutReservationClient>,
  configOverrides: Partial<AppConfig> = {}
): Promise<{
  service: HutReservationService;
  cache: LocalCache;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hut-reservation-service-"));
  const config = testConfig(dir, configOverrides);
  const cache = new LocalCache(dir);
  const geocoder = new NominatimGeocoder(config.nominatim);
  const service = new HutReservationService(config, client as HutReservationClient, cache, geocoder);
  return { service, cache };
}

function catalogHut(hutId: number, hutName = `Hut ${hutId}`) {
  return {
    hutId,
    hutName,
    hutCountry: "CH",
    coordinatesRaw: `46.${String(hutId).padStart(2, "0")},8.${String(hutId).padStart(2, "0")}`,
    coordinates: { lat: 46 + hutId / 1000, lon: 8 + hutId / 1000 },
    altitude: null,
    serviced: "SERVICED",
    totalBedsInfo: null,
    info: null
  };
}

describe("HutReservationService", () => {
  it("searches by country, canton cache, and distance without geocoding inline", async () => {
    const { service, cache } = await makeService({});
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: [
        {
          hutId: 1,
          hutName: "Uri Hut",
          hutCountry: "CH",
          coordinatesRaw: "46.88,8.64",
          coordinates: { lat: 46.88, lon: 8.64 },
          altitude: null,
          serviced: "SERVICED",
          totalBedsInfo: null,
          info: null
        },
        {
          hutId: 2,
          hutName: "Bern Hut",
          hutCountry: "CH",
          coordinatesRaw: "46.60,7.90",
          coordinates: { lat: 46.6, lon: 7.9 },
          altitude: null,
          serviced: "SERVICED",
          totalBedsInfo: null,
          info: null
        }
      ]
    });
    await cache.writeAreaCache({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      provider: "test",
      entries: {
        "1": {
          hutId: 1,
          lat: 46.88,
          lon: 8.64,
          countryCode: "CH",
          country: "Switzerland",
          canton: "Uri",
          state: "Uri",
          displayName: "Uri, Switzerland",
          attribution: "test",
          refreshedAt: "2026-06-18T00:00:00.000Z"
        }
      }
    });

    const result = await service.searchHuts({
      country: "CH",
      canton: "Uri",
      near: { lat: 46.88, lon: 8.64, radiusKm: 5 }
    });

    expect(result.huts).toHaveLength(1);
    expect(result.huts[0]?.hutName).toBe("Uri Hut");
    expect(result.warnings).toEqual([
      "1 huts did not have canton data in the local area cache. Run refresh_area_cache with a configured Nominatim-compatible provider."
    ]);
  });

  it("returns only huts with enough free places on every exact-period night", async () => {
    const client: Partial<HutReservationClient> = {
      getHutStatus: async (): Promise<HutStatusResponse> => ({
        hutStatus: "SERVICED",
        categories: [{ categoryID: 10 }]
      }),
      checkAvailability: async (hutId: number) => ({
        availabilityPerDayDTOs:
          hutId === 1
            ? [
                { day: "04.07.2026", freePlaces: 4, availableForReservation: true },
                { day: "05.07.2026", freePlaces: 3, availableForReservation: true }
              ]
            : [
                { day: "04.07.2026", freePlaces: 4, availableForReservation: true },
                { day: "05.07.2026", freePlaces: 1, availableForReservation: true }
              ]
      })
    };
    const { service, cache } = await makeService(client);
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: [
        {
          hutId: 1,
          hutName: "Available Hut",
          hutCountry: "CH",
          coordinatesRaw: "46.88,8.64",
          coordinates: { lat: 46.88, lon: 8.64 },
          altitude: null,
          serviced: "SERVICED",
          totalBedsInfo: null,
          info: null
        },
        {
          hutId: 2,
          hutName: "Tight Hut",
          hutCountry: "CH",
          coordinatesRaw: "46.60,7.90",
          coordinates: { lat: 46.6, lon: 7.9 },
          altitude: null,
          serviced: "SERVICED",
          totalBedsInfo: null,
          info: null
        }
      ]
    });

    const result = await service.searchAvailability({
      country: "CH",
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-06",
      partySize: 3
    });

    expect(result.available.map((item) => item.hut.hutName)).toEqual(["Available Hut"]);
    expect(result.unavailable.map((item) => item.hut.hutName)).toEqual(["Tight Hut"]);
    expect(result.totalCandidates).toBe(2);
    expect(result.checkedCandidates).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("checks all matched huts by default instead of silently stopping at the first page", async () => {
    const checkedHutIds: number[] = [];
    const client: Partial<HutReservationClient> = {
      getHutStatus: async (): Promise<HutStatusResponse> => ({ hutStatus: "SERVICED", categories: [{ categoryID: 10 }] }),
      checkAvailability: async (hutId: number) => {
        checkedHutIds.push(hutId);
        return {
          availabilityPerDayDTOs: [{ day: "04.07.2026", freePlaces: hutId === 35 ? 4 : 0, availableForReservation: true }]
        };
      }
    };
    const { service, cache } = await makeService(client);
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: Array.from({ length: 35 }, (_, index) => catalogHut(index + 1))
    });

    const result = await service.searchAvailability({
      country: "CH",
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2
    });

    expect(checkedHutIds).toHaveLength(35);
    expect(result.available.map((item) => item.hut.hutId)).toEqual([35]);
    expect(result.totalCandidates).toBe(35);
    expect(result.checkedCandidates).toBe(35);
    expect(result.truncated).toBe(false);
  });

  it("marks availability results partial when maxCandidates truncates matched huts", async () => {
    const client: Partial<HutReservationClient> = {
      getHutStatus: async (): Promise<HutStatusResponse> => ({ hutStatus: "SERVICED", categories: [{ categoryID: 10 }] }),
      checkAvailability: async () => ({
        availabilityPerDayDTOs: [{ day: "04.07.2026", freePlaces: 4, availableForReservation: true }]
      })
    };
    const { service, cache } = await makeService(client);
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: [catalogHut(1), catalogHut(2), catalogHut(3)]
    });

    const result = await service.searchAvailability({
      country: "CH",
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      maxCandidates: 2
    });

    expect(result.totalCandidates).toBe(3);
    expect(result.checkedCandidates).toBe(2);
    expect(result.candidateLimit).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain(
      "Availability search checked 2 of 3 matched huts because maxCandidates was set. Results are partial."
    );
  });

  it("prepares booking by checking the requested hut id directly", async () => {
    const checkedHutIds: number[] = [];
    const client: Partial<HutReservationClient> = {
      getHutStatus: async (): Promise<HutStatusResponse> => ({ hutStatus: "SERVICED", categories: [{ categoryID: 10 }] }),
      checkAvailability: async (hutId: number) => {
        checkedHutIds.push(hutId);
        return {
          availabilityPerDayDTOs: [{ day: "04.07.2026", freePlaces: 2, availableForReservation: true }]
        };
      }
    };
    const { service, cache } = await makeService(client);
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: [catalogHut(1, "Name prefix"), catalogHut(2, "Name prefix")]
    });

    const result = await service.prepareBooking({
      hutId: 2,
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2
    });

    expect(result.prepared).toBe(true);
    expect(checkedHutIds).toEqual([2]);
  });

  it("does not persist guest data or raw booking payloads by default", async () => {
    const client: Partial<HutReservationClient> = {
      getHutStatus: async (): Promise<HutStatusResponse> => ({ hutStatus: "SERVICED", categories: [{ categoryID: 10 }] }),
      checkAvailability: async () => ({
        availabilityPerDayDTOs: [{ day: "04.07.2026", freePlaces: 2, availableForReservation: true }]
      })
    };
    const { service, cache } = await makeService(client);
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: [catalogHut(1, "Private Hut")]
    });

    const result = await service.prepareBooking({
      hutId: 1,
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      guestData: { name: "Sensitive Guest" },
      rawReservationPayload: { secret: "raw payload" }
    });
    const publicDraft = result.draft as Record<string, unknown>;
    const savedDraft = await cache.getDraft(String(publicDraft.id));

    expect(savedDraft).not.toBeNull();
    expect(savedDraft).not.toHaveProperty("guestData");
    expect(savedDraft).not.toHaveProperty("rawReservationPayload");
    expect(publicDraft).not.toHaveProperty("guestData");
    expect(publicDraft).not.toHaveProperty("rawReservationPayload");
  });

  it("persists raw booking payload only for experimental headless confirmation", async () => {
    const rawReservationPayload = { expected: "payload" };
    const submitted: unknown[] = [];
    const client: Partial<HutReservationClient> = {
      getHutStatus: async (): Promise<HutStatusResponse> => ({ hutStatus: "SERVICED", categories: [{ categoryID: 10 }] }),
      checkAvailability: async () => ({
        availabilityPerDayDTOs: [{ day: "04.07.2026", freePlaces: 2, availableForReservation: true }]
      }),
      preBook: async (payload: unknown) => {
        submitted.push(payload);
        return { ok: true };
      },
      submitReservation: async (payload: unknown) => {
        submitted.push(payload);
        return { reservationId: 123 };
      }
    };
    const { service, cache } = await makeService(client, { experimentalWrites: true });
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: [catalogHut(1, "Experimental Hut")]
    });

    const prepared = await service.prepareBooking({
      hutId: 1,
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      rawReservationPayload
    });
    const publicDraft = prepared.draft as Record<string, unknown>;
    const savedDraft = await cache.getDraft(String(publicDraft.id));

    expect(savedDraft).toMatchObject({ rawReservationPayload });
    expect(publicDraft).not.toHaveProperty("rawReservationPayload");

    await expect(service.confirmBooking({ draftId: String(publicDraft.id) })).resolves.toMatchObject({ confirmed: true });
    expect(submitted).toEqual([rawReservationPayload, rawReservationPayload]);
  });

  it("returns an actionable handoff when experimental confirmation lacks a raw payload", async () => {
    const client: Partial<HutReservationClient> = {
      getHutStatus: async (): Promise<HutStatusResponse> => ({ hutStatus: "SERVICED", categories: [{ categoryID: 10 }] }),
      checkAvailability: async () => ({
        availabilityPerDayDTOs: [{ day: "04.07.2026", freePlaces: 2, availableForReservation: true }]
      })
    };
    const { service, cache } = await makeService(client, { experimentalWrites: true });
    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      failures: [],
      huts: [catalogHut(1, "Browser Handoff Hut")]
    });

    const prepared = await service.prepareBooking({
      hutId: 1,
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2
    });
    const publicDraft = prepared.draft as Record<string, unknown>;

    await expect(service.confirmBooking({ draftId: String(publicDraft.id) })).resolves.toMatchObject({
      confirmed: false,
      requiresBrowserHandoff: true,
      reason: expect.stringContaining("raw upstream reservation payload")
    });
  });

  it("does not persist raw cancellation summaries", async () => {
    const client: Partial<HutReservationClient> = {
      getReservationSummary: async () => ({
        reservationId: 123,
        hutName: "Reserved Hut",
        guest: { name: "Sensitive Guest" }
      })
    };
    const { service, cache } = await makeService(client);

    const result = await service.prepareCancellation({
      reservationPublicId: "public-123",
      reservationId: 123
    });
    const publicDraft = result.draft as Record<string, unknown>;
    const savedDraft = await cache.getDraft(String(publicDraft.id));

    expect(savedDraft).not.toBeNull();
    expect(savedDraft).not.toHaveProperty("rawReservation");
    expect(publicDraft).not.toHaveProperty("rawReservation");
    expect(savedDraft).toMatchObject({
      kind: "cancellation",
      reservationPublicId: "public-123",
      reservationId: 123
    });
  });
});
