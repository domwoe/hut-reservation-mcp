import { loadConfig } from "./config.js";
import { createService } from "./factory.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.liveSmoke) {
    throw new Error("Set HUT_RESERVATION_LIVE_SMOKE=true to run live read-only smoke checks.");
  }

  const service = createService(config);
  const catalog = await service.refreshHutCatalog({ country: "CH", limit: 3 });
  const search = await service.searchHuts({ country: "CH", limit: 3 });
  console.log(
    JSON.stringify(
      {
        catalogHuts: catalog.huts.length,
        catalogFailures: catalog.failures.length,
        searchReturned: search.returned
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
