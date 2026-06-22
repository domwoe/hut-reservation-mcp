import { afterEach, describe, expect, it, vi } from "vitest";

import { HutReservationClient, UpstreamApiError } from "../src/upstream.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("HutReservationClient authentication", () => {
  it("uses SAC browser session cookies for authenticated requests", async () => {
    const requests: Array<{ url: string; method: string; cookie: string | null; xsrf: string | null }> = [];
    const client = new HutReservationClient(
      {
        baseUrl: "https://www.hut-reservation.org",
        credentials: { mode: "sac", sessionCookie: "session-value", xsrfToken: "xsrf-token" }
      },
      async (input, init = {}) => {
        requests.push({
          url: String(input),
          method: init.method ?? "GET",
          cookie: new Headers(init.headers).get("Cookie"),
          xsrf: new Headers(init.headers).get("X-XSRF-TOKEN")
        });
        return Response.json([{ hutId: 603, hutName: "Berggasthaus Bruesti", hutCountry: "CH" }]);
      }
    );

    await expect(client.listReservations({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })).resolves.toEqual([
      { hutId: 603, hutName: "Berggasthaus Bruesti", hutCountry: "CH" }
    ]);
    expect(requests).toEqual([
      {
        url: "https://www.hut-reservation.org/api/v1/reservation/myReservations?researchFilter=&page=1&size=20&open=true&dateFrom=01.07.2026&dateTo=31.07.2026&sortList=arrivalDate&sortOrder=ASC&profiId=",
        method: "GET",
        cookie: "SESSION=session-value; XSRF-TOKEN=xsrf-token",
        xsrf: null
      }
    ]);
  });

  it("sends the SAC XSRF token on authenticated writes", async () => {
    const requests: Array<{ method: string; cookie: string | null; xsrf: string | null }> = [];
    const client = new HutReservationClient(
      {
        baseUrl: "https://www.hut-reservation.org",
        credentials: { mode: "sac", sessionCookie: "session-value", xsrfToken: "xsrf-token" }
      },
      async (_input, init = {}) => {
        requests.push({
          method: init.method ?? "GET",
          cookie: new Headers(init.headers).get("Cookie"),
          xsrf: new Headers(init.headers).get("X-XSRF-TOKEN")
        });
        return Response.json({ ok: true });
      }
    );

    await client.preBook({ hutId: 603 });
    expect(requests[0]).toEqual({
      method: "POST",
      cookie: "SESSION=session-value; XSRF-TOKEN=xsrf-token",
      xsrf: "xsrf-token"
    });
  });

  it("does not authenticate read-only hut catalog requests when credentials are configured", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const client = new HutReservationClient(
      {
        baseUrl: "https://www.hut-reservation.org",
        credentials: { username: "person@example.com", password: "secret", mode: "standard" }
      },
      async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, method: init.method ?? "GET", body: init.body?.toString() });

        if (url.endsWith("/api/v1/csrf")) {
          return Response.json(
            { token: "csrf-token" },
            { headers: { "set-cookie": "XSRF-TOKEN=csrf-token; Path=/" } }
          );
        }

        if (url.endsWith("/api/v1/users/login")) {
          return new Response(null, {
            status: 204,
            headers: { "set-cookie": "JSESSIONID=session-id; Path=/; HttpOnly" }
          });
        }

        if (url.endsWith("/api/v1/manage/hutsList")) {
          return Response.json([{ hutId: 603, hutName: "Berggasthaus Bruesti", hutCountry: "CH" }]);
        }

        return new Response(null, { status: 404 });
      }
    );

    await expect(client.getHutsList()).resolves.toEqual([
      { hutId: 603, hutName: "Berggasthaus Bruesti", hutCountry: "CH" }
    ]);
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/api/v1/manage/hutsList"]
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBeUndefined();
  });

  it("omits SAC session cookies for public hut availability reads", async () => {
    const requests: Array<{ method: string; cookie: string | null; xsrf: string | null }> = [];
    const client = new HutReservationClient(
      {
        baseUrl: "https://www.hut-reservation.org",
        credentials: { mode: "sac", sessionCookie: "stale-session", xsrfToken: "stale-xsrf" }
      },
      async (_input, init = {}) => {
        requests.push({
          method: init.method ?? "GET",
          cookie: new Headers(init.headers).get("Cookie"),
          xsrf: new Headers(init.headers).get("X-XSRF-TOKEN")
        });
        return Response.json({ hutStatus: "SERVICED", categories: [] });
      }
    );

    await client.getHutStatus(603, "2026-07-04", "2026-07-05");

    expect(requests).toEqual([{ method: "POST", cookie: null, xsrf: null }]);
  });

  it("aborts upstream requests after the configured timeout", async () => {
    vi.useFakeTimers();
    const client = new HutReservationClient(
      {
        baseUrl: "https://www.hut-reservation.org",
        credentials: null,
        requestTimeoutMs: 50
      },
      async (_input, init = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        })
    );

    const request = expect(client.getHutsList()).rejects.toMatchObject({
      name: "UpstreamApiError",
      status: 0,
      message: "hut-reservation.org request timed out after 50 ms for /api/v1/manage/hutsList"
    } satisfies Partial<UpstreamApiError>);
    await vi.advanceTimersByTimeAsync(50);

    await request;
  });

  it("clears the timeout timer after successful upstream responses", async () => {
    vi.useFakeTimers();
    const client = new HutReservationClient(
      {
        baseUrl: "https://www.hut-reservation.org",
        credentials: null,
        requestTimeoutMs: 1_000
      },
      async () => Response.json([{ hutId: 603, hutName: "Berggasthaus Bruesti", hutCountry: "CH" }])
    );

    await expect(client.getHutsList()).resolves.toEqual([
      { hutId: 603, hutName: "Berggasthaus Bruesti", hutCountry: "CH" }
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
