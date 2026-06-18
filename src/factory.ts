import { LocalCache } from "./cache.js";
import type { AppConfig } from "./types.js";
import { NominatimGeocoder } from "./geocoder.js";
import { createMcpServer } from "./server.js";
import { HutReservationService } from "./service.js";
import { HutReservationClient } from "./upstream.js";

export function createService(config: AppConfig): HutReservationService {
  const client = new HutReservationClient(config);
  const cache = new LocalCache(config.cacheDir);
  const geocoder = new NominatimGeocoder(config.nominatim);
  return new HutReservationService(config, client, cache, geocoder);
}

export function createServerFromConfig(config: AppConfig) {
  return createMcpServer(createService(config));
}
