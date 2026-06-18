import type {
  AppConfig,
  AreaFilter,
  AvailabilityFailure,
  AvailabilityInput,
  AvailabilityResponse,
  AvailabilityResult,
  BookingDraft,
  CancellationDraft,
  CatalogCache,
  CatalogFailure,
  HutAvailability,
  HutRecord,
  NightAvailability,
  ReservationListInput,
  SearchHut,
  SearchHutsInput,
  SearchHutsResult
} from "./types.js";
import { LocalCache } from "./cache.js";
import { mapConcurrent } from "./concurrency.js";
import { nightsBetween, swissToIsoDate } from "./date.js";
import { distanceKm, normalizeAreaName, normalizeCountry, parseCoordinates } from "./geo.js";
import { NominatimGeocoder } from "./geocoder.js";
import { HutReservationClient } from "./upstream.js";

const DEFAULT_SEARCH_LIMIT = 25;
const AVAILABILITY_CHECK_CONCURRENCY = 4;
const DRAFT_TTL_MS = 15 * 60 * 1000;

export class HutReservationService {
  constructor(
    readonly config: AppConfig,
    readonly client: HutReservationClient,
    readonly cache: LocalCache,
    readonly geocoder: NominatimGeocoder
  ) {}

  async authStatus(): Promise<Record<string, unknown>> {
    const cache = await this.cache.status();
    return {
      ...this.client.authStatus,
      mode: this.config.credentials?.mode ?? null,
      cacheDir: this.config.cacheDir,
      experimentalWrites: this.config.experimentalWrites,
      geocoder: {
        configured: this.geocoder.configured,
        provider: this.geocoder.providerName()
      },
      cache
    };
  }

  async refreshHutCatalog(input: { country?: string; limit?: number } = {}): Promise<CatalogCache> {
    const all = await this.client.getHutsList();
    const country = input.country ? normalizeCountry(input.country) : null;
    const filtered = all
      .filter((hut) => !country || normalizeCountry(hut.hutCountry ?? "") === country)
      .slice(0, input.limit);

    const failures: CatalogFailure[] = [];
    const records = await mapConcurrent(filtered, 12, async (item): Promise<HutRecord | null> => {
      try {
        const info = await this.client.getHutInfo(item.hutId);
        const coordinatesRaw = info.coordinates ?? null;
        return {
          hutId: item.hutId,
          hutName: info.hutName ?? item.hutName,
          hutCountry: item.hutCountry ?? null,
          coordinatesRaw,
          coordinates: parseCoordinates(coordinatesRaw),
          altitude: info.altitude ?? null,
          serviced: info.serviced ?? null,
          totalBedsInfo: info.totalBedsInfo ?? null,
          info
        };
      } catch (error) {
        failures.push({
          hutId: item.hutId,
          hutName: item.hutName,
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      }
    });

    const catalog: CatalogCache = {
      refreshedAt: new Date().toISOString(),
      source: "hut-reservation.org",
      huts: records.filter((record): record is HutRecord => record !== null),
      failures
    };
    await this.cache.writeCatalog(catalog);
    return catalog;
  }

  async refreshAreaCache(input: { force?: boolean; limit?: number } = {}): Promise<Record<string, unknown>> {
    const catalog = await this.requireCatalog();
    const areaCache = await this.cache.readAreaCache();
    const provider = this.geocoder.providerName();
    const result = await this.geocoder.refresh(catalog.huts, {
      force: input.force,
      limit: input.limit,
      existing: areaCache.entries
    });
    const updated = await this.cache.upsertAreaEntries(result.provider, result.entries);
    const missingCanton = catalog.huts.filter((hut) => {
      const entry = updated.entries[String(hut.hutId)];
      return hut.coordinates && (!entry || entry.provider !== provider || !entry.canton);
    }).length;
    return {
      provider: result.provider,
      refreshed: result.entries.length,
      skipped: result.skipped,
      failures: result.failures,
      totalCached: Object.keys(updated.entries).length,
      entriesWithCanton: Object.values(updated.entries).filter((entry) => Boolean(entry.canton)).length,
      missingCanton,
      attribution: "Geocoder data may include OpenStreetMap data; preserve provider attribution in user-facing output."
    };
  }

  async searchHuts(input: SearchHutsInput = {}): Promise<SearchHutsResult> {
    const catalog = await this.requireCatalog();
    const areaCache = await this.cache.readAreaCache();
    const warnings: string[] = [];
    let cantonMisses = 0;
    let huts: SearchHut[] = catalog.huts.map((hut) => ({ ...hut, area: areaCache.entries[String(hut.hutId)] ?? null }));

    huts = this.applyAreaFilter(huts, input, () => {
      cantonMisses += 1;
    });

    if (input.near) {
      huts = huts
        .map((hut) => ({
          ...hut,
          distanceKm: hut.coordinates ? distanceKm(input.near as { lat: number; lon: number }, hut.coordinates) : undefined
        }))
        .filter((hut) => hut.distanceKm !== undefined && hut.distanceKm <= input.near!.radiusKm)
        .sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY));
    }

    if (cantonMisses > 0) {
      warnings.push(
        `${cantonMisses} huts did not have canton data in the local area cache. Run refresh_area_cache with a configured Nominatim-compatible provider.`
      );
    }

    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const totalMatched = huts.length;
    huts = huts.slice(offset, offset + limit);

    return {
      huts,
      totalMatched,
      returned: huts.length,
      offset,
      warnings
    };
  }

  async searchAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
    const nights = nightsBetween(input.arrivalDate, input.departureDate);
    const candidateSearch = await this.searchHuts({
      country: input.country,
      canton: input.canton,
      text: input.text,
      near: input.near,
      limit: input.maxCandidates ?? Number.MAX_SAFE_INTEGER
    });
    const candidateLimit = input.maxCandidates ?? null;
    const truncated = candidateSearch.returned < candidateSearch.totalMatched;

    const failures: AvailabilityFailure[] = [];
    const checked = await mapConcurrent(candidateSearch.huts, AVAILABILITY_CHECK_CONCURRENCY, async (hut) => {
      try {
        return await this.checkHutAvailability(hut, input.arrivalDate, input.departureDate, nights);
      } catch (error) {
        failures.push({
          hutId: hut.hutId,
          hutName: hut.hutName,
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      }
    });

    const all = checked.filter((item): item is HutAvailability => item !== null);
    const available = all.filter((item) =>
      item.nights.every(
        (night) => night.availableForReservation && Number.isFinite(night.freePlaces) && night.freePlaces >= input.partySize
      )
    );
    const unavailable = all.filter((item) => !available.includes(item));
    const warnings = [...candidateSearch.warnings];
    if (truncated) {
      warnings.push(
        `Availability search checked ${candidateSearch.returned} of ${candidateSearch.totalMatched} matched huts because maxCandidates was set. Results are partial.`
      );
    }

    return {
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      partySize: input.partySize,
      totalCandidates: candidateSearch.totalMatched,
      checkedCandidates: candidateSearch.returned,
      candidateLimit,
      truncated,
      available: available.slice(0, input.limit ?? DEFAULT_SEARCH_LIMIT),
      unavailable,
      failures,
      warnings
    };
  }

  async prepareBooking(input: {
    hutId: number;
    arrivalDate: string;
    departureDate: string;
    partySize: number;
    guestData?: Record<string, unknown>;
    rawReservationPayload?: unknown;
  }): Promise<Record<string, unknown>> {
    const catalog = await this.requireCatalog();
    const hut = catalog.huts.find((candidate) => candidate.hutId === input.hutId);
    if (!hut) throw new Error(`Hut ${input.hutId} is not in the local catalog. Run refresh_hut_catalog first.`);

    const exact = await this.checkHutAvailabilityById(hut.hutId, input.arrivalDate, input.departureDate);
    const isAvailable = exact.nights.every(
      (night) => night.availableForReservation && Number.isFinite(night.freePlaces) && night.freePlaces >= input.partySize
    );
    if (!isAvailable) {
      return {
        prepared: false,
        reason: "The requested hut is not currently available for the exact period and party size.",
        availability: exact
      };
    }

    const now = Date.now();
    const draftInput: Omit<BookingDraft, "id"> = {
      kind: "booking",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DRAFT_TTL_MS).toISOString(),
      hutId: hut.hutId,
      hutName: hut.hutName,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      partySize: input.partySize,
      bookingUrl: bookingUrl(this.config.baseUrl, hut.hutId)
    };
    if (this.config.experimentalWrites && input.rawReservationPayload !== undefined) {
      draftInput.rawReservationPayload = input.rawReservationPayload;
    }
    const draft = (await this.cache.saveDraft(draftInput)) as BookingDraft;

    return {
      prepared: true,
      draft: publicDraft(draft),
      canConfirmHeadlessly: Boolean(input.rawReservationPayload && this.config.experimentalWrites),
      browserHandoffUrl: draft.bookingUrl,
      warning:
        "Headless booking submit needs the full upstream reservation payload. Without experimental writes and rawReservationPayload, use the browser handoff URL."
    };
  }

  async confirmBooking(input: { draftId: string }): Promise<Record<string, unknown>> {
    const draft = await this.cache.getDraft(input.draftId);
    if (!draft || draft.kind !== "booking") throw new Error("Booking draft was not found or has expired.");

    const bookingDraft = draft as BookingDraft;
    const availability = await this.checkHutAvailabilityById(
      bookingDraft.hutId,
      bookingDraft.arrivalDate,
      bookingDraft.departureDate
    );
    const stillAvailable = availability.nights.every(
      (night) =>
        night.availableForReservation && Number.isFinite(night.freePlaces) && night.freePlaces >= bookingDraft.partySize
    );
    if (!stillAvailable) {
      throw new Error("Booking draft can no longer be confirmed because availability changed.");
    }

    if (!this.config.experimentalWrites) {
      return {
        confirmed: false,
        requiresBrowserHandoff: true,
        browserHandoffUrl: bookingDraft.bookingUrl,
        reason: "Experimental writes are disabled. No upstream booking was created."
      };
    }

    if (bookingDraft.rawReservationPayload === undefined) {
      return {
        confirmed: false,
        requiresBrowserHandoff: true,
        browserHandoffUrl: bookingDraft.bookingUrl,
        reason:
          "Experimental writes are enabled, but this draft has no raw upstream reservation payload. Prepare a new booking with rawReservationPayload to confirm headlessly."
      };
    }

    const preBook = await this.client.preBook(bookingDraft.rawReservationPayload);
    const submit = await this.client.submitReservation(bookingDraft.rawReservationPayload);
    await this.cache.deleteDraft(bookingDraft.id);
    return {
      confirmed: true,
      preBook,
      submit
    };
  }

  async listBookings(input: ReservationListInput): Promise<unknown> {
    return this.client.listReservations(input);
  }

  async prepareCancellation(input: {
    reservationPublicId: string;
    reservationId?: number;
    newArrivalDate?: string;
    newDepartureDate?: string;
    newPeopleNumber?: number;
  }): Promise<Record<string, unknown>> {
    const now = Date.now();
    let summary: unknown = null;
    let partialCancellationFee: unknown = null;

    try {
      summary = await this.client.getReservationSummary(input.reservationPublicId);
    } catch (error) {
      summary = { error: error instanceof Error ? error.message : String(error) };
    }

    if (input.newArrivalDate && input.newDepartureDate && input.newPeopleNumber !== undefined) {
      partialCancellationFee = await this.client.getPartialCancellationFee({
        reservationPublicId: input.reservationPublicId,
        newArrivalDate: input.newArrivalDate,
        newDepartureDate: input.newDepartureDate,
        newPeopleNumber: input.newPeopleNumber
      });
    }

    const draft = (await this.cache.saveDraft({
      kind: "cancellation",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DRAFT_TTL_MS).toISOString(),
      reservationPublicId: input.reservationPublicId,
      reservationId: input.reservationId,
      fallbackUrl: reservationListUrl(this.config.baseUrl)
    })) as CancellationDraft;

    return {
      prepared: true,
      draft: publicDraft(draft),
      summary,
      partialCancellationFee,
      canConfirmHeadlessly: false,
      browserHandoffUrl: draft.fallbackUrl,
      warning:
        "Confirmed-reservation cancellation endpoint semantics are not safe enough to automate yet. Use the browser handoff URL."
    };
  }

  async confirmCancellation(input: { draftId: string }): Promise<Record<string, unknown>> {
    const draft = await this.cache.getDraft(input.draftId);
    if (!draft || draft.kind !== "cancellation") {
      throw new Error("Cancellation draft was not found or has expired.");
    }

    const cancellationDraft = draft as CancellationDraft;
    return {
      confirmed: false,
      requiresBrowserHandoff: true,
      browserHandoffUrl: cancellationDraft.fallbackUrl,
      reason:
        "No safe headless cancellation implementation is enabled. The SPA exposes delete for pre-book reservations, but confirmed cancellation semantics need a separate verified implementation."
    };
  }

  private async requireCatalog(): Promise<CatalogCache> {
    const catalog = await this.cache.readCatalog();
    if (!catalog) {
      throw new Error("Local hut catalog is empty. Run refresh_hut_catalog first.");
    }
    return catalog;
  }

  private async checkHutAvailabilityById(
    hutId: number,
    arrivalDate: string,
    departureDate: string
  ): Promise<HutAvailability> {
    const hut = await this.searchHutById(hutId);
    const nights = nightsBetween(arrivalDate, departureDate);
    return this.checkHutAvailability(hut, arrivalDate, departureDate, nights);
  }

  private async checkHutAvailability(
    hut: SearchHut,
    arrivalDate: string,
    departureDate: string,
    nights: string[]
  ): Promise<HutAvailability> {
    const status = await this.client.getHutStatus(hut.hutId, arrivalDate, departureDate);
    const availability = await this.client.checkAvailability(hut.hutId, arrivalDate, departureDate, status);
    const nightAvailability = normalizeNights(availability, nights);
    const freePlacesMin = Math.min(...nightAvailability.map((night) => night.freePlaces));
    return {
      hut,
      freePlacesMin,
      nights: nightAvailability,
      bookingUrl: bookingUrl(this.config.baseUrl, hut.hutId)
    };
  }

  private async searchHutById(hutId: number): Promise<SearchHut> {
    const catalog = await this.requireCatalog();
    const hut = catalog.huts.find((candidate) => candidate.hutId === hutId);
    if (!hut) throw new Error(`Hut ${hutId} is not in the local catalog. Run refresh_hut_catalog first.`);
    const areaCache = await this.cache.readAreaCache();
    return { ...hut, area: areaCache.entries[String(hut.hutId)] ?? null };
  }

  private applyAreaFilter(huts: SearchHut[], filter: AreaFilter, onMissingCanton: () => void): SearchHut[] {
    const country = filter.country ? normalizeCountry(filter.country) : null;
    const canton = filter.canton ? normalizeAreaName(filter.canton) : null;
    const text = filter.text ? normalizeAreaName(filter.text) : null;

    return huts.filter((hut) => {
      if (country && normalizeCountry(hut.hutCountry ?? hut.area?.countryCode ?? "") !== country) return false;
      if (text && !normalizeAreaName(hut.hutName).includes(text)) return false;
      if (canton) {
        if (!hut.area?.canton) {
          onMissingCanton();
          return false;
        }
        if (normalizeAreaName(hut.area.canton) !== canton) return false;
      }
      return true;
    });
  }
}

function normalizeNights(response: AvailabilityResponse, expectedIsoNights: string[]): NightAvailability[] {
  const upstreamNights = response.availabilityPerDayDTOs ?? [];
  return expectedIsoNights.map((isoDate) => {
    const upstream = upstreamNights.find((night) => {
      if (!night.day) return false;
      try {
        return swissToIsoDate(night.day) === isoDate;
      } catch {
        return false;
      }
    });
    return {
      date: isoDate,
      freePlaces: Number(upstream?.freePlaces ?? 0),
      availableForReservation: upstream?.availableForReservation !== false
    };
  });
}

export function bookingUrl(baseUrl: string, hutId: number): string {
  return `${baseUrl.replace(/\/$/, "")}/reservation/book-hut/${hutId}/wizard`;
}

export function reservationListUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/reservation/list`;
}

function publicDraft(draft: BookingDraft | CancellationDraft): Record<string, unknown> {
  if (draft.kind === "booking") {
    return {
      id: draft.id,
      kind: draft.kind,
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
      hutId: draft.hutId,
      hutName: draft.hutName,
      arrivalDate: draft.arrivalDate,
      departureDate: draft.departureDate,
      partySize: draft.partySize,
      bookingUrl: draft.bookingUrl
    };
  }

  return {
    id: draft.id,
    kind: draft.kind,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    reservationPublicId: draft.reservationPublicId,
    reservationId: draft.reservationId,
    fallbackUrl: draft.fallbackUrl
  };
}
