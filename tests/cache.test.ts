import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalCache } from "../src/cache.js";

describe("LocalCache", () => {
  it("round-trips catalog and expires drafts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hut-reservation-cache-"));
    const cache = new LocalCache(dir);

    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      huts: [],
      failures: []
    });
    await expect(cache.readCatalog()).resolves.toMatchObject({ source: "hut-reservation.org" });

    const draft = await cache.saveDraft({
      kind: "booking",
      createdAt: "2026-06-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      hutId: 603,
      hutName: "Berggasthaus Brusti",
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      bookingUrl: "https://example.test/reservation/book-hut/603/wizard"
    });

    await expect(cache.getDraft(draft.id)).resolves.toBeNull();
  });

  it("reports cache status without exposing draft contents and sweeps expired drafts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hut-reservation-cache-"));
    const cache = new LocalCache(dir);

    await cache.writeCatalog({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      source: "hut-reservation.org",
      huts: [
        {
          hutId: 1,
          hutName: "Uri Hut",
          hutCountry: "CH",
          coordinatesRaw: "46.88,8.64",
          coordinates: { lat: 46.88, lon: 8.64 },
          altitude: null,
          serviced: null,
          totalBedsInfo: null,
          info: null
        }
      ],
      failures: [{ hutId: 2, hutName: "Broken Hut", error: "missing" }]
    });
    await cache.writeAreaCache({
      refreshedAt: "2026-06-18T00:00:00.000Z",
      provider: "test-provider",
      entries: {
        "1": {
          hutId: 1,
          lat: 46.88,
          lon: 8.64,
          provider: "test-provider",
          countryCode: "CH",
          country: "Switzerland",
          canton: "Uri",
          state: "Uri",
          displayName: "Uri, Switzerland",
          attribution: "test",
          refreshedAt: "2026-06-18T00:00:00.000Z"
        },
        "2": {
          hutId: 2,
          lat: 46.6,
          lon: 7.9,
          provider: "test-provider",
          countryCode: "CH",
          country: "Switzerland",
          canton: null,
          state: null,
          displayName: "Switzerland",
          attribution: "test",
          refreshedAt: "2026-06-18T00:00:00.000Z"
        }
      }
    });
    await cache.saveDraft({
      kind: "booking",
      createdAt: "2026-06-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      hutId: 1,
      hutName: "Uri Hut",
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      bookingUrl: "https://example.test/reservation/book-hut/1/wizard"
    });
    await cache.saveDraft({
      kind: "booking",
      createdAt: "2026-06-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      hutId: 2,
      hutName: "Old Hut",
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      bookingUrl: "https://example.test/reservation/book-hut/2/wizard"
    });

    const status = await cache.status();
    expect(status.catalog).toMatchObject({ cached: true, hutCount: 1, failureCount: 1 });
    expect(status.areas).toMatchObject({ cachedEntries: 2, entriesWithCanton: 1, missingCanton: 1 });
    expect(status.drafts).toMatchObject({ active: 1, expired: 1 });
    expect(JSON.stringify(status)).not.toContain("Uri Hut");

    await expect(cache.sweepExpiredDrafts()).resolves.toBe(1);
    await expect(cache.status()).resolves.toMatchObject({ drafts: { active: 1, expired: 0 } });
  });

  it("preserves concurrent draft mutations from separate cache instances", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hut-reservation-cache-"));
    const first = new LocalCache(dir);
    const second = new LocalCache(dir);
    const drafts = Array.from({ length: 20 }, (_, index) => ({
      id: `draft-${index}`,
      kind: "booking" as const,
      createdAt: "2026-06-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      hutId: index + 1,
      hutName: `Hut ${index + 1}`,
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      bookingUrl: `https://example.test/reservation/book-hut/${index + 1}/wizard`
    }));

    await Promise.all(drafts.map((draft, index) => (index % 2 === 0 ? first : second).saveDraft(draft)));

    await expect(first.status()).resolves.toMatchObject({ drafts: { active: drafts.length, expired: 0 } });
    await Promise.all(drafts.map((draft) => expect(second.getDraft(draft.id)).resolves.toMatchObject({ id: draft.id })));
    await expect(fs.access(path.join(dir, ".hut-reservation-cache.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes stale lock files before mutating the cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hut-reservation-cache-"));
    const cache = new LocalCache(dir);
    const lockPath = path.join(dir, ".hut-reservation-cache.lock");
    await fs.writeFile(lockPath, "stale lock", "utf8");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    const draft = await cache.saveDraft({
      id: "after-stale-lock",
      kind: "booking",
      createdAt: "2026-06-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      hutId: 1,
      hutName: "Fresh Hut",
      arrivalDate: "2026-07-04",
      departureDate: "2026-07-05",
      partySize: 2,
      bookingUrl: "https://example.test/reservation/book-hut/1/wizard"
    });

    await expect(cache.getDraft(draft.id)).resolves.toMatchObject({ id: "after-stale-lock" });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
