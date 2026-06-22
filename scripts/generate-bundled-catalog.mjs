#!/usr/bin/env node
// Regenerate data/catalog.json for bundling with the npm package.
// Run before publishing a new version: pnpm run generate:catalog
//
// Requires valid hut-reservation.org credentials in .env (standard or sac mode).
// The catalog is auth-gated upstream; the individual hut-info and availability
// endpoints remain public so users can search without authenticating.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createService } from "../src/factory.js";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const outputPath = path.join(root, "data", "catalog.json");

const config = loadConfig();
if (!config.credentials) {
  console.error("No credentials configured. Set HUT_RESERVATION_AUTH_MODE and credentials in .env.");
  process.exit(1);
}

console.log("Fetching hut catalog from hut-reservation.org…");
const service = createService(config);
const catalog = await service.refreshHutCatalog();

// Drop the heavy per-hut `info` blob (bed categories + multilingual
// descriptions are ~90% of the size and aren't used for search or
// availability). Search keeps name/coordinates/altitude/serviced/beds from the
// top-level fields; an authenticated refresh_hut_catalog restores full info.
const { bundled: _bundled, ...rest } = catalog;
const clean = {
  ...rest,
  huts: rest.huts.map((hut) => ({ ...hut, info: null }))
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
const sizeKb = Math.round((await fs.stat(outputPath)).size / 1024);
console.log(`Wrote ${catalog.huts.length} huts to ${outputPath} (${catalog.failures.length} failures, ${sizeKb} KB).`);
console.log("Commit data/catalog.json and bump the package version before publishing.");
