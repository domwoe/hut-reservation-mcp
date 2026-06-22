import type {
  AvailabilityResponse,
  Credentials,
  HutInfo,
  HutListItem,
  HutStatusResponse,
  ReservationListInput
} from "./types.js";
import { toSwissDate } from "./date.js";

type FetchLike = typeof fetch;

interface UpstreamClientConfig {
  baseUrl: string;
  credentials: Credentials | null;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface RequestOptions {
  authenticated?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
  includeSession?: boolean;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export class UpstreamApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = "UpstreamApiError";
  }
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  clear(name?: string): void {
    if (name) {
      this.cookies.delete(name);
      return;
    }
    this.cookies.clear();
  }

  get(name: string): string | null {
    return this.cookies.get(name) ?? null;
  }

  hasAuthenticatedSession(): boolean {
    return this.cookies.has("JSESSIONID") || this.cookies.has("SESSION");
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string | null {
    if (this.cookies.size === 0) return null;
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  store(headers: Headers): void {
    const setCookieHeaders = getSetCookieHeaders(headers);
    for (const header of setCookieHeaders) {
      const [pair] = header.split(";");
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;
      if (value.length === 0) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const direct = withGetSetCookie.getSetCookie?.();
  if (direct && direct.length > 0) return direct;

  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((part) => part.trim());
}

export class HutReservationClient {
  private readonly jar = new CookieJar();
  private csrfToken: string | null = null;
  private authenticatedAt: string | null = null;

  constructor(
    private readonly config: UpstreamClientConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.seedConfiguredSession();
  }

  get authStatus(): { credentialsConfigured: boolean; authenticated: boolean; authenticatedAt: string | null } {
    return {
      credentialsConfigured: this.config.credentials !== null,
      authenticated: this.jar.hasAuthenticatedSession(),
      authenticatedAt: this.authenticatedAt
    };
  }

  async logout(): Promise<void> {
    if (this.jar.get("JSESSIONID")) {
      try {
        await this.request("POST", "/api/v1/users/logout", { authenticated: true });
      } finally {
        this.jar.clear();
        this.csrfToken = null;
        this.authenticatedAt = null;
      }
    }
  }

  async login(): Promise<void> {
    const credentials = this.requireCredentials();
    if (credentials.mode === "sac") {
      throw new Error(
        "SAC session cookies are missing or expired. Log in through the browser and update HUT_RESERVATION_SESSION_COOKIE and HUT_RESERVATION_XSRF_TOKEN."
      );
    }

    this.jar.clear("JSESSIONID");
    await this.fetchCsrf();

    const form = new URLSearchParams();
    form.set("username", credentials.username);
    form.set("password", credentials.password);

    const response = await this.rawFetch("/api/v1/users/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(this.csrfToken ? { "X-XSRF-TOKEN": this.csrfToken } : {})
      },
      body: form.toString()
    });

    await this.throwIfNotOk(response);
    this.authenticatedAt = new Date().toISOString();
  }

  async getHutsList(): Promise<HutListItem[]> {
    return this.request<HutListItem[]>("GET", "/api/v1/manage/hutsList");
  }

  async getHutInfo(hutId: number): Promise<HutInfo> {
    return this.request<HutInfo>("GET", `/api/v1/reservation/hutInfo/${hutId}`);
  }

  async getHutStatus(hutId: number, arrivalDate: string, departureDate: string): Promise<HutStatusResponse> {
    return this.request<HutStatusResponse>("POST", `/api/v1/reservation/hutStatus/${hutId}`, {
      body: {
        arrivalDate: toSwissDate(arrivalDate),
        departureDate: toSwissDate(departureDate)
      }
    });
  }

  async checkAvailability(
    hutId: number,
    arrivalDate: string,
    departureDate: string,
    status: HutStatusResponse
  ): Promise<AvailabilityResponse> {
    const categories = status.categories ?? [];
    return this.request<AvailabilityResponse>("POST", `/api/v1/reservation/checkAvailability/${hutId}`, {
      body: {
        arrivalDate: toSwissDate(arrivalDate),
        departureDate: toSwissDate(departureDate),
        numberOfPeople: 0,
        nextPossibleReservations: false,
        peoplePerCategory: categories.map((category) => ({
          categoryId: category.categoryID ?? category.categoryId ?? category.id,
          people: 0
        })),
        hutId,
        serviced: status.hutStatus,
        isWaitingListEnabled: status.isWaitingListEnabled ?? false,
        isWaitingListAccepted: status.isWaitingListAccepted ?? false,
        allowAnyBedCategory: false
      }
    });
  }

  async listReservations(input: ReservationListInput): Promise<unknown> {
    return this.request("GET", "/api/v1/reservation/myReservations", {
      authenticated: true,
      query: {
        researchFilter: input.researchFilter ?? "",
        page: input.page ?? 1,
        size: input.size ?? 20,
        open: input.open ?? true,
        dateFrom: toSwissDate(input.dateFrom),
        dateTo: toSwissDate(input.dateTo),
        sortList: input.sortList ?? "arrivalDate",
        sortOrder: input.sortOrder ?? "ASC",
        profiId: input.profiId ?? ""
      }
    });
  }

  async getReservationSummary(reservationPublicId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/reservation/reservationSummary/${encodeURIComponent(reservationPublicId)}`, {
      authenticated: true
    });
  }

  async getPartialCancellationFee(input: {
    reservationPublicId: string;
    newArrivalDate: string;
    newDepartureDate: string;
    newPeopleNumber: number;
  }): Promise<unknown> {
    return this.request("GET", "/api/v1/reservation/getPartialCancellationFee", {
      authenticated: true,
      query: {
        reservationPublicId: input.reservationPublicId,
        newArrivalDate: toSwissDate(input.newArrivalDate),
        newDepartureDate: toSwissDate(input.newDepartureDate),
        newPeopleNumber: input.newPeopleNumber
      }
    });
  }

  async preBook(rawPayload: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/reservation/preBook", {
      authenticated: true,
      body: rawPayload
    });
  }

  async submitReservation(rawPayload: unknown): Promise<unknown> {
    return this.request("PUT", "/api/v1/reservation/submit", {
      authenticated: true,
      body: rawPayload
    });
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    if (options.authenticated) await this.ensureAuthenticated();

    const response = await this.rawFetch(path, {
      method,
      headers: this.buildHeaders(
        method,
        options.headers,
        options.body !== undefined,
        options.includeSession ?? options.authenticated === true
      ),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      query: options.query
    });

    if (response.status === 401 && options.authenticated) {
      this.jar.clear();
      this.csrfToken = null;
      await this.ensureAuthenticated();
      const retry = await this.rawFetch(path, {
        method,
        headers: this.buildHeaders(method, options.headers, options.body !== undefined, true),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        query: options.query
      });
      await this.throwIfNotOk(retry);
      return this.parseJson<T>(retry);
    }

    await this.throwIfNotOk(response);
    return this.parseJson<T>(response);
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.jar.hasAuthenticatedSession()) return;
    await this.login();
  }

  private seedConfiguredSession(): void {
    const credentials = this.config.credentials;
    if (credentials?.mode !== "sac") return;
    this.jar.set("SESSION", credentials.sessionCookie);
    this.jar.set("XSRF-TOKEN", credentials.xsrfToken);
    this.csrfToken = credentials.xsrfToken;
    this.authenticatedAt = new Date().toISOString();
  }

  private requireCredentials(): Credentials {
    if (!this.config.credentials) {
      throw new Error("Hut reservation credentials are not configured");
    }
    return this.config.credentials;
  }

  private async fetchCsrf(): Promise<void> {
    const response = await this.rawFetch("/api/v1/csrf", { method: "GET" });
    await this.throwIfNotOk(response);
    const body = (await this.parseJson<{ token?: string }>(response)) ?? {};
    this.csrfToken = body.token ?? this.jar.get("XSRF-TOKEN");
    if (!this.csrfToken) throw new Error("CSRF token was not returned by upstream");
  }

  private buildHeaders(
    method: string,
    extra: Record<string, string> | undefined,
    hasJsonBody: boolean,
    includeSession: boolean
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...extra
    };

    const cookie = includeSession ? this.jar.header() : null;
    if (cookie) headers.Cookie = cookie;
    if (hasJsonBody) headers["Content-Type"] = "application/json";
    if (includeSession && method !== "GET" && this.csrfToken) headers["X-XSRF-TOKEN"] = this.csrfToken;
    return headers;
  }

  private async rawFetch(
    path: string,
    init: RequestInit & { query?: RequestOptions["query"] }
  ): Promise<Response> {
    const url = new URL(path, ensureTrailingSlash(this.config.baseUrl));
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }

    const { query: _query, signal, ...fetchInit } = init;
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutController = timeoutMs > 0 ? new AbortController() : null;
    const timeout = timeoutController
      ? setTimeout(() => {
          timeoutController.abort(new Error(`hut-reservation.org request timed out after ${timeoutMs} ms`));
        }, timeoutMs)
      : null;
    const composedSignal = composeAbortSignals([signal, timeoutController?.signal].filter(Boolean) as AbortSignal[]);

    try {
      const response = await this.fetchImpl(url, {
        ...fetchInit,
        signal: composedSignal
      });
      this.jar.store(response.headers);
      return response;
    } catch (error) {
      if (timeoutController?.signal.aborted) {
        throw new UpstreamApiError(
          `hut-reservation.org request timed out after ${timeoutMs} ms for ${url.pathname}`,
          0,
          { timeoutMs, path: url.pathname }
        );
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async parseJson<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async throwIfNotOk(response: Response): Promise<void> {
    if (response.ok) return;
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    const message =
      typeof body === "object" && body !== null && "description" in body
        ? String((body as { description: unknown }).description)
        : `hut-reservation.org returned HTTP ${response.status}`;
    throw new UpstreamApiError(message, response.status, body);
  }
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function composeAbortSignals(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      return controller.signal;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller.signal;
}
