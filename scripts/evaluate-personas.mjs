#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const serverCommand = process.argv.slice(2);
if (serverCommand[0] === "--") serverCommand.shift();

if (serverCommand.length === 0) {
  console.error("Usage: node scripts/evaluate-personas.mjs -- <command> [args...]");
  process.exit(2);
}

const catalog = {
  refreshedAt: "2026-06-18T00:00:00.000Z",
  source: "hut-reservation.org",
  huts: [
    hut(603, "Berggasthaus Bruesti", "46.864,8.574", "SERVICED", "54 beds"),
    hut(604, "Spannorthuette SAC", "46.809,8.474", "SERVICED", "44 beds"),
    hut(701, "Bluemlisalphuette SAC", "46.512,7.770", "SERVICED", "115 beds"),
    hut(702, "Gspaltenhornhuette SAC", "46.510,7.817", "SERVICED", "75 beds"),
    hut(901, "Cabane de Moiry", "46.108,7.574", "SERVICED", "108 beds")
  ],
  failures: []
};

const areaCache = {
  refreshedAt: "2026-06-18T00:00:00.000Z",
  provider: "persona-fixture",
  entries: {
    "603": area(603, 46.864, 8.574, "Uri", "Uri, Switzerland"),
    "604": area(604, 46.809, 8.474, "Uri", "Uri, Switzerland"),
    "701": area(701, 46.512, 7.77, "Bern", "Kandersteg, Bern, Switzerland"),
    "702": area(702, 46.51, 7.817, "Bern", "Kandersteg, Bern, Switzerland"),
    "901": area(901, 46.108, 7.574, "Valais", "Valais, Switzerland")
  }
};

let transport;
let cacheDir;
let mockApi;
const stderrChunks = [];

const timeout = setTimeout(() => {
  console.error("Persona evaluation timed out");
  void transport?.close().finally(() => process.exit(1));
}, 20_000);

try {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "hut-reservation-personas-"));
  await seedCache(cacheDir);

  mockApi = await startMockApi();

  const client = new Client({ name: "hut-reservation-persona-eval", version: "0.1.0" });
  transport = new StdioClientTransport({
    command: serverCommand[0],
    args: serverCommand.slice(1),
    cwd: repoRoot,
    stderr: "pipe",
    env: {
      ...process.env,
      HUT_RESERVATION_AUTH_MODE: "sac",
      HUT_RESERVATION_SESSION_COOKIE: "evaluation-session",
      HUT_RESERVATION_XSRF_TOKEN: "evaluation-xsrf",
      HUT_RESERVATION_BASE_URL: mockApi.baseUrl,
      HUT_RESERVATION_CACHE_DIR: cacheDir,
      HUT_RESERVATION_DOTENV_DISABLED: "true",
      HUT_RESERVATION_EXPERIMENTAL_WRITES: "false",
      HUT_RESERVATION_REQUEST_TIMEOUT_MS: "5000"
    }
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  await client.connect(transport);

  const scenarios = [
    {
      id: "family-uri-weekend",
      persona: "Maya and Jonas, two parents planning a weekend hut stay with two children.",
      goal: "Find an available Uri-area hut for 4 people, then prepare a safe browser handoff draft.",
      run: runFamilyUriWeekend
    },
    {
      id: "reservation-change-safety",
      persona: "Nina, an existing guest who needs to reduce an open reservation after one friend drops out.",
      goal: "Review current bookings and prepare a cancellation/change handoff without executing cancellation.",
      run: runReservationChangeSafety
    }
  ];

  const results = [];
  for (const scenario of scenarios) {
    const checks = [];
    const startCallIndex = mockApi.calls.length;
    try {
      await scenario.run({ client, mockApi, startCallIndex }, checks);
    } catch (error) {
      checks.push({
        name: "scenario completed without MCP/tool failure",
        passed: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    const passed = checks.filter((check) => check.passed).length;
    const score = checks.length === 0 ? 0 : Math.round((passed / checks.length) * 100) / 10;
    results.push({ ...scenario, checks, passed, score });
  }

  await client.close();
  clearTimeout(timeout);

  printResults(results, mockApi);

  if (results.some((result) => result.passed !== result.checks.length)) {
    process.exitCode = 1;
  }
} catch (error) {
  clearTimeout(timeout);
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  console.error(error instanceof Error ? error.message : String(error));
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  await transport?.close().catch(() => undefined);
  await mockApi?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
}

async function runFamilyUriWeekend({ client, mockApi, startCallIndex }, checks) {
  const status = await callTool(client, "auth_status", {});
  check(checks, "cache is ready with seeded hut and canton data", status.cache?.catalog?.hutCount === 5 && status.cache?.areas?.entriesWithCanton === 5);
  check(checks, "server reports experimental writes disabled", status.experimentalWrites === false);

  const search = await callTool(client, "search_huts", {
    country: "CH",
    canton: "Uri",
    near: { lat: 46.86, lon: 8.58, radiusKm: 20 },
    limit: 10
  });
  check(checks, "search finds the two Uri candidates", sameIds(search.huts, [603, 604]) && search.totalMatched === 2);
  check(checks, "distance sorting puts the nearest Uri hut first", search.huts?.[0]?.hutId === 603 && typeof search.huts?.[0]?.distanceKm === "number");

  const availability = await callTool(client, "search_hut_availability", {
    country: "CH",
    canton: "Uri",
    near: { lat: 46.86, lon: 8.58, radiusKm: 20 },
    arrivalDate: "2026-07-04",
    departureDate: "2026-07-06",
    partySize: 4,
    limit: 10
  });
  check(checks, "availability checks every matched hut without truncation", availability.checkedCandidates === 2 && availability.totalCandidates === 2 && availability.truncated === false);
  check(checks, "availability requires enough free places on every night", sameIds(availability.available, [603]) && sameIds(availability.unavailable, [604]));

  const draft = await callTool(client, "prepare_booking", {
    hutId: 603,
    arrivalDate: "2026-07-04",
    departureDate: "2026-07-06",
    partySize: 4,
    guestData: { partyType: "family", hasChildren: true }
  });
  check(checks, "booking preparation creates a draft for the requested hut", draft.prepared === true && draft.draft?.hutId === 603 && draft.draft?.partySize === 4);
  check(checks, "booking remains browser-handoff only", draft.canConfirmHeadlessly === false && String(draft.browserHandoffUrl).endsWith("/reservation/book-hut/603/wizard"));

  const scenarioCalls = mockApi.calls.slice(startCallIndex);
  check(
    checks,
    "upstream date payloads use Swiss DD.MM.YYYY format",
    scenarioCalls.some((call) => call.path === "/api/v1/reservation/hutStatus/603" && call.body?.arrivalDate === "04.07.2026" && call.body?.departureDate === "06.07.2026")
  );
  check(checks, "no booking write endpoint was called", !scenarioCalls.some(isBookingWriteCall));
}

async function runReservationChangeSafety({ client, mockApi, startCallIndex }, checks) {
  const reservations = await callTool(client, "list_bookings", {
    dateFrom: "2026-07-01",
    dateTo: "2026-08-31",
    open: true,
    page: 1,
    size: 20
  });
  check(checks, "list_bookings returns the open reservation fixture", reservations.reservations?.items?.[0]?.publicId === "R-URI-2026-0001");

  const preparation = await callTool(client, "prepare_cancellation", {
    reservationPublicId: "R-URI-2026-0001",
    reservationId: 4242,
    newArrivalDate: "2026-07-04",
    newDepartureDate: "2026-07-06",
    newPeopleNumber: 3
  });
  check(checks, "cancellation/change preparation creates a draft", preparation.prepared === true && preparation.draft?.kind === "cancellation");
  check(checks, "reservation summary context is included", preparation.summary?.publicId === "R-URI-2026-0001" && preparation.summary?.hutName === "Berggasthaus Bruesti");
  check(checks, "partial cancellation fee context is included", preparation.partialCancellationFee?.currency === "CHF" && preparation.partialCancellationFee?.fee === 18);
  check(checks, "cancellation remains browser-handoff only", preparation.canConfirmHeadlessly === false && String(preparation.browserHandoffUrl).endsWith("/reservation/list"));

  const scenarioCalls = mockApi.calls.slice(startCallIndex);
  check(
    checks,
    "booking list query converts ISO dates to Swiss dates",
    scenarioCalls.some((call) => call.path === "/api/v1/reservation/myReservations" && call.query.dateFrom === "01.07.2026" && call.query.dateTo === "31.08.2026")
  );
  check(
    checks,
    "partial-change query converts proposed dates to Swiss dates",
    scenarioCalls.some((call) => call.path === "/api/v1/reservation/getPartialCancellationFee" && call.query.newArrivalDate === "04.07.2026" && call.query.newDepartureDate === "06.07.2026")
  );
  check(checks, "no cancellation delete endpoint was called", !scenarioCalls.some(isCancellationWriteCall));
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const structured = result.structuredContent ?? parseTextContent(result.content);
  if (result.isError) {
    const message = structured?.error ?? JSON.stringify(structured);
    throw new Error(`${name} failed: ${message}`);
  }
  return structured;
}

function parseTextContent(content) {
  const text = content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

function check(checks, name, passed, detail = "") {
  checks.push({ name, passed: Boolean(passed), detail });
}

function sameIds(items, expected) {
  return JSON.stringify((items ?? []).map((item) => item.hut?.hutId ?? item.hutId)) === JSON.stringify(expected);
}

function isBookingWriteCall(call) {
  return call.method === "POST" && call.path === "/api/v1/reservation/preBook" || call.method === "PUT" && call.path === "/api/v1/reservation/submit";
}

function isCancellationWriteCall(call) {
  return call.path.startsWith("/api/v1/reservation/delete/");
}

function printResults(results, mockApi) {
  console.log("Persona MCP evaluation");
  console.log(`Mock upstream: ${mockApi.baseUrl}`);
  console.log("");
  for (const result of results) {
    console.log(`${result.id}: ${result.score.toFixed(1)}/10 (${result.passed}/${result.checks.length} checks)`);
    console.log(`Persona: ${result.persona}`);
    console.log(`Goal: ${result.goal}`);
    for (const checkResult of result.checks) {
      const mark = checkResult.passed ? "PASS" : "FAIL";
      console.log(`  ${mark} ${checkResult.name}${checkResult.detail ? `: ${checkResult.detail}` : ""}`);
    }
    console.log("");
  }
  const totalChecks = results.reduce((sum, result) => sum + result.checks.length, 0);
  const totalPassed = results.reduce((sum, result) => sum + result.passed, 0);
  const averageScore = results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.score, 0) / results.length;
  console.log(`Overall: ${averageScore.toFixed(1)}/10 (${totalPassed}/${totalChecks} checks)`);
}

async function seedCache(directory) {
  await writeFile(path.join(directory, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await writeFile(path.join(directory, "areas.json"), `${JSON.stringify(areaCache, null, 2)}\n`, "utf8");
}

function hut(hutId, hutName, coordinatesRaw, serviced, totalBedsInfo) {
  const [lat, lon] = coordinatesRaw.split(",").map(Number);
  return {
    hutId,
    hutName,
    hutCountry: "CH",
    coordinatesRaw,
    coordinates: { lat, lon },
    altitude: null,
    serviced,
    totalBedsInfo,
    info: null
  };
}

function area(hutId, lat, lon, canton, displayName) {
  return {
    hutId,
    lat,
    lon,
    countryCode: "CH",
    country: "Switzerland",
    canton,
    state: canton,
    displayName,
    attribution: "persona-fixture",
    refreshedAt: "2026-06-18T00:00:00.000Z"
  };
}

async function startMockApi() {
  const calls = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readJsonBody(request);
    calls.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body
    });

    if (request.method === "POST" && /^\/api\/v1\/reservation\/hutStatus\/\d+$/.test(url.pathname)) {
      sendJson(response, {
        hutStatus: "SERVICED",
        categories: [{ categoryID: 10, categoryName: "sleeping place" }],
        isWaitingListEnabled: false,
        isWaitingListAccepted: false
      });
      return;
    }

    const availabilityMatch = url.pathname.match(/^\/api\/v1\/reservation\/checkAvailability\/(\d+)$/);
    if (request.method === "POST" && availabilityMatch) {
      sendJson(response, availabilityFor(Number(availabilityMatch[1])));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/reservation/myReservations") {
      sendJson(response, {
        items: [
          {
            id: 4242,
            publicId: "R-URI-2026-0001",
            hutName: "Berggasthaus Bruesti",
            arrivalDate: "04.07.2026",
            departureDate: "06.07.2026",
            peopleNumber: 4,
            status: "OPEN"
          }
        ],
        page: Number(url.searchParams.get("page") ?? 1),
        size: Number(url.searchParams.get("size") ?? 20),
        totalElements: 1
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/reservation/reservationSummary/R-URI-2026-0001") {
      sendJson(response, {
        id: 4242,
        publicId: "R-URI-2026-0001",
        hutName: "Berggasthaus Bruesti",
        arrivalDate: "04.07.2026",
        departureDate: "06.07.2026",
        peopleNumber: 4
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/reservation/getPartialCancellationFee") {
      sendJson(response, {
        reservationPublicId: url.searchParams.get("reservationPublicId"),
        newPeopleNumber: Number(url.searchParams.get("newPeopleNumber")),
        currency: "CHF",
        fee: 18
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/reservation/preBook") {
      sendJson(response, { error: "persona evaluator should not call preBook" }, 500);
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/v1/reservation/submit") {
      sendJson(response, { error: "persona evaluator should not call submit" }, 500);
      return;
    }

    sendJson(response, { error: `Unhandled mock endpoint: ${request.method} ${url.pathname}` }, 404);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock API did not bind to a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(value));
}

function availabilityFor(hutId) {
  const byHut = {
    603: [
      { day: "04.07.2026", freePlaces: 6, availableForReservation: true },
      { day: "05.07.2026", freePlaces: 5, availableForReservation: true }
    ],
    604: [
      { day: "04.07.2026", freePlaces: 3, availableForReservation: true },
      { day: "05.07.2026", freePlaces: 2, availableForReservation: true }
    ],
    701: [
      { day: "10.08.2026", freePlaces: 2, availableForReservation: true },
      { day: "11.08.2026", freePlaces: 2, availableForReservation: true }
    ],
    702: [
      { day: "10.08.2026", freePlaces: 1, availableForReservation: true },
      { day: "11.08.2026", freePlaces: 0, availableForReservation: true }
    ],
    901: [
      { day: "10.08.2026", freePlaces: 8, availableForReservation: true },
      { day: "11.08.2026", freePlaces: 8, availableForReservation: true }
    ]
  };
  return {
    availabilityPerDayDTOs: byHut[hutId] ?? []
  };
}
