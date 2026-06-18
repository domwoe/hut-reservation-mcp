import type { AreaCacheEntry, HutRecord, NominatimConfig } from "./types.js";
import { sleep } from "./concurrency.js";

type FetchLike = typeof fetch;

interface NominatimReverseResponse {
  licence?: string;
  display_name?: string;
  address?: {
    country?: string;
    country_code?: string;
    state?: string;
    county?: string;
    state_district?: string;
    [key: string]: unknown;
  };
}

export interface GeocodeRefreshOptions {
  force?: boolean;
  limit?: number;
  existing: Record<string, AreaCacheEntry>;
}

export interface GeocodeRefreshResult {
  entries: AreaCacheEntry[];
  skipped: number;
  failures: Array<{ hutId: number; hutName: string; error: string }>;
  provider: string;
}

export class NominatimGeocoder {
  constructor(
    private readonly config: NominatimConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  get configured(): boolean {
    return Boolean(this.config.baseUrl && this.config.userAgent);
  }

  providerName(): string {
    return this.config.baseUrl ?? "unconfigured";
  }

  async refresh(huts: HutRecord[], options: GeocodeRefreshOptions): Promise<GeocodeRefreshResult> {
    this.assertConfigured();

    const entries: AreaCacheEntry[] = [];
    const failures: Array<{ hutId: number; hutName: string; error: string }> = [];
    let skipped = 0;
    let processed = 0;

    for (const hut of huts) {
      if (!hut.coordinates) {
        skipped += 1;
        continue;
      }
      if (!options.force && !shouldRefresh(hut, options.existing[String(hut.hutId)], this.providerName())) {
        skipped += 1;
        continue;
      }
      if (options.limit !== undefined && processed >= options.limit) {
        skipped += 1;
        continue;
      }
      if (processed > 0) await sleep(this.config.minIntervalMs);
      processed += 1;

      try {
        entries.push(await this.reverse(hut));
      } catch (error) {
        failures.push({
          hutId: hut.hutId,
          hutName: hut.hutName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return { entries, skipped, failures, provider: this.providerName() };
  }

  private async reverse(hut: HutRecord): Promise<AreaCacheEntry> {
    if (!hut.coordinates) throw new Error("Cannot geocode hut without coordinates");
    const url = new URL("/reverse", this.config.baseUrl ?? undefined);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(hut.coordinates.lat));
    url.searchParams.set("lon", String(hut.coordinates.lon));
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "5");
    url.searchParams.set("layer", "address");
    if (this.config.email) url.searchParams.set("email", this.config.email);

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": this.config.userAgent ?? "hut-reservation-mcp"
      }
    });
    if (!response.ok) throw new Error(`Nominatim returned HTTP ${response.status}`);
    const body = (await response.json()) as NominatimReverseResponse;
    const address = body.address ?? {};
    const state = textOrNull(address.state ?? address.county ?? address.state_district);

    return {
      hutId: hut.hutId,
      lat: hut.coordinates.lat,
      lon: hut.coordinates.lon,
      provider: this.providerName(),
      countryCode: textOrNull(address.country_code)?.toUpperCase() ?? null,
      country: textOrNull(address.country),
      canton: state,
      state,
      displayName: textOrNull(body.display_name),
      attribution: textOrNull(body.licence),
      refreshedAt: new Date().toISOString()
    };
  }

  private assertConfigured(): void {
    if (!this.config.baseUrl || !this.config.userAgent) {
      throw new Error(
        "Nominatim geocoder is not configured. Set NOMINATIM_BASE_URL and NOMINATIM_USER_AGENT before refreshing area cache."
      );
    }
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function shouldRefresh(hut: HutRecord, existing: AreaCacheEntry | undefined, provider: string): boolean {
  if (!hut.coordinates) return false;
  if (!existing) return true;
  if (!existing.provider || existing.provider !== provider) return true;
  if (existing.lat !== hut.coordinates.lat || existing.lon !== hut.coordinates.lon) return true;
  return !existing.canton;
}
