#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CORE_TOOLS = ["auth_status", "search_huts"];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const serverCommand = process.argv.slice(2);
if (serverCommand[0] === "--") serverCommand.shift();

if (serverCommand.length === 0) {
  console.error("Usage: node scripts/smoke-mcp.mjs -- <command> [args...]");
  process.exit(2);
}

let transport;
let cacheDir;
const stderrChunks = [];

const timeout = setTimeout(() => {
  console.error("MCP smoke timed out");
  void transport?.close().finally(() => process.exit(1));
}, 15_000);

try {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "hut-reservation-mcp-smoke-"));
  await writeSmokeCatalog(cacheDir);

  const client = new Client({ name: "hut-reservation-mcp-smoke", version: "0.1.0" });
  transport = new StdioClientTransport({
    command: serverCommand[0],
    args: serverCommand.slice(1),
    cwd: repoRoot,
    stderr: "pipe",
    env: {
      HUT_RESERVATION_CACHE_DIR: cacheDir,
      HUT_RESERVATION_DOTENV_DISABLED: "true"
    }
  });

  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const toolName of CORE_TOOLS) {
    assert(toolNames.has(toolName), `Missing expected MCP tool: ${toolName}`);
  }

  const authStatus = await client.callTool({ name: "auth_status", arguments: {} });
  assert(!authStatus.isError, "auth_status returned an MCP error");
  assertObject(authStatus.structuredContent, "auth_status structuredContent");

  const searchResult = await client.callTool({ name: "search_huts", arguments: { limit: 1 } });
  assert(!searchResult.isError, "search_huts returned an MCP error");
  const search = assertObject(searchResult.structuredContent, "search_huts structuredContent");
  assert(search.totalMatched === 1, `Expected search_huts totalMatched=1, got ${String(search.totalMatched)}`);
  assert(search.returned === 1, `Expected search_huts returned=1, got ${String(search.returned)}`);

  await client.close();
  clearTimeout(timeout);
  console.log(`MCP smoke passed: ${listed.tools.length} tools, auth_status, search_huts`);
} catch (error) {
  clearTimeout(timeout);
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  console.error(error instanceof Error ? error.message : String(error));
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  await transport?.close().catch(() => undefined);
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
}

async function writeSmokeCatalog(directory) {
  const catalog = {
    refreshedAt: "2026-06-18T00:00:00.000Z",
    source: "hut-reservation.org",
    huts: [
      {
        hutId: 1,
        hutName: "Smoke Test Hut",
        hutCountry: "CH",
        coordinatesRaw: "46.88,8.64",
        coordinates: { lat: 46.88, lon: 8.64 },
        altitude: null,
        serviced: null,
        totalBedsInfo: null,
        info: null
      }
    ],
    failures: []
  };
  await writeFile(path.join(directory, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertObject(value, label) {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} was not an object`);
  return value;
}
