export type AuthMode = "standard" | "sac";

export interface StandardCredentials {
  mode: "standard";
  username: string;
  password: string;
}

export interface SacSessionCredentials {
  mode: "sac";
  sessionCookie: string;
  xsrfToken: string;
}

export type Credentials = StandardCredentials | SacSessionCredentials;

export interface AppConfig {
  baseUrl: string;
  cacheDir: string;
  credentials: Credentials | null;
  requestTimeoutMs: number;
  experimentalWrites: boolean;
  liveSmoke: boolean;
  nominatim: NominatimConfig;
}

export interface NominatimConfig {
  baseUrl: string | null;
  userAgent: string | null;
  email: string | null;
  minIntervalMs: number;
}

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface HutListItem {
  hutId: number;
  hutName: string;
  hutCountry?: string;
}

export interface HutInfo {
  hutId: number;
  hutName: string;
  coordinates?: string | null;
  altitude?: string | null;
  totalBedsInfo?: string | null;
  serviced?: string | null;
  [key: string]: unknown;
}

export interface HutRecord {
  hutId: number;
  hutName: string;
  hutCountry: string | null;
  coordinatesRaw: string | null;
  coordinates: Coordinates | null;
  altitude: string | null;
  serviced: string | null;
  totalBedsInfo: string | null;
  info: HutInfo | null;
}

export interface CatalogCache {
  refreshedAt: string;
  source: "hut-reservation.org";
  huts: HutRecord[];
  failures: CatalogFailure[];
}

export interface CatalogFailure {
  hutId: number;
  hutName?: string;
  error: string;
}

export interface AreaCacheEntry {
  hutId: number;
  lat: number;
  lon: number;
  provider?: string;
  countryCode: string | null;
  country: string | null;
  canton: string | null;
  state: string | null;
  displayName: string | null;
  attribution: string | null;
  refreshedAt: string;
}

export interface AreaCache {
  refreshedAt: string;
  provider: string;
  entries: Record<string, AreaCacheEntry>;
}

export interface AreaFilter {
  country?: string;
  canton?: string;
  text?: string;
  near?: {
    lat: number;
    lon: number;
    radiusKm: number;
  };
}

export interface SearchHutsInput extends AreaFilter {
  limit?: number;
  offset?: number;
}

export interface SearchHutsResult {
  huts: SearchHut[];
  totalMatched: number;
  returned: number;
  offset: number;
  warnings: string[];
}

export interface SearchHut extends HutRecord {
  distanceKm?: number;
  area?: AreaCacheEntry | null;
}

export interface AvailabilityInput extends AreaFilter {
  arrivalDate: string;
  departureDate: string;
  partySize: number;
  limit?: number;
  maxCandidates?: number;
}

export interface AvailabilityResult {
  arrivalDate: string;
  departureDate: string;
  partySize: number;
  totalCandidates: number;
  checkedCandidates: number;
  candidateLimit: number | null;
  truncated: boolean;
  available: HutAvailability[];
  unavailable: HutAvailability[];
  failures: AvailabilityFailure[];
  warnings: string[];
}

export interface HutAvailability {
  hut: SearchHut;
  freePlacesMin: number;
  nights: NightAvailability[];
  bookingUrl: string;
}

export interface NightAvailability {
  date: string;
  freePlaces: number;
  availableForReservation: boolean;
}

export interface AvailabilityFailure {
  hutId: number;
  hutName: string;
  error: string;
}

export interface HutStatusResponse {
  hutStatus?: string;
  categories?: HutCategory[];
  isWaitingListEnabled?: boolean;
  isWaitingListAccepted?: boolean;
  [key: string]: unknown;
}

export interface HutCategory {
  categoryID?: number;
  categoryId?: number;
  id?: number;
  categoryName?: string;
  [key: string]: unknown;
}

export interface AvailabilityResponse {
  arrivalDate?: string;
  departureDate?: string;
  waitingListEnabled?: boolean;
  availabilityPerDayDTOs?: UpstreamNightAvailability[];
  [key: string]: unknown;
}

export interface UpstreamNightAvailability {
  day?: string;
  freePlaces?: number;
  hutStatus?: string;
  dayOfWeek?: string;
  availableForReservation?: boolean;
  bedCategoriesData?: unknown[];
  [key: string]: unknown;
}

export type DraftKind = "booking" | "cancellation";

export interface DraftBase {
  id: string;
  kind: DraftKind;
  createdAt: string;
  expiresAt: string;
}

export interface BookingDraft extends DraftBase {
  kind: "booking";
  hutId: number;
  hutName: string;
  arrivalDate: string;
  departureDate: string;
  partySize: number;
  bookingUrl: string;
  rawReservationPayload?: unknown;
}

export interface CancellationDraft extends DraftBase {
  kind: "cancellation";
  reservationPublicId: string;
  reservationId?: number;
  fallbackUrl: string;
}

export type Draft = BookingDraft | CancellationDraft;

export interface ReservationListInput {
  researchFilter?: string;
  open?: boolean;
  dateFrom: string;
  dateTo: string;
  page?: number;
  size?: number;
  sortList?: string;
  sortOrder?: "ASC" | "DESC";
  profiId?: string;
}

export interface ToolFailure {
  error: string;
  detail?: string;
}

export interface CacheStatus {
  cacheDir: string;
  catalog: {
    cached: boolean;
    hutCount: number;
    failureCount: number;
    refreshedAt: string | null;
  };
  areas: {
    cachedEntries: number;
    entriesWithCanton: number;
    missingCanton: number;
    provider: string;
    refreshedAt: string | null;
  };
  drafts: {
    active: number;
    expired: number;
    refreshedAt: string | null;
  };
}
