import type { Coordinates } from "./types.js";

export function parseCoordinates(raw: string | null | undefined): Coordinates | null {
  if (!raw) return null;
  const sep = raw.includes("/") ? "/" : ",";
  const [latRaw, lonRaw] = raw.split(sep);
  const lat = Number.parseFloat(latRaw?.trim() ?? "");
  const lon = Number.parseFloat(lonRaw?.trim() ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export function distanceKm(a: Coordinates, b: Coordinates): number {
  const earthRadiusKm = 6371.0088;
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const deltaLat = degreesToRadians(b.lat - a.lat);
  const deltaLon = degreesToRadians(b.lon - a.lon);

  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function normalizeCountry(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeAreaName(value: string): string {
  return value.trim().toLocaleLowerCase("de-CH");
}
