import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sleep } from "./concurrency.js";
import type { AreaCache, AreaCacheEntry, BookingDraft, CacheStatus, CancellationDraft, CatalogCache, Draft } from "./types.js";

interface DraftCache {
  refreshedAt: string;
  drafts: Record<string, Draft>;
}

type DraftInput = (Omit<BookingDraft, "id"> | Omit<CancellationDraft, "id">) & { id?: string };

const LOCK_FILE_NAME = ".hut-reservation-cache.lock";
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export class LocalCache {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cacheDir: string) {}

  async readCatalog(): Promise<CatalogCache | null> {
    return this.readJson<CatalogCache>("catalog.json");
  }

  async writeCatalog(catalog: CatalogCache): Promise<void> {
    await this.writeJson("catalog.json", catalog);
  }

  async readAreaCache(): Promise<AreaCache> {
    return (
      (await this.readJson<AreaCache>("areas.json")) ?? {
        refreshedAt: new Date(0).toISOString(),
        provider: "none",
        entries: {}
      }
    );
  }

  async writeAreaCache(areaCache: AreaCache): Promise<void> {
    await this.writeJson("areas.json", areaCache);
  }

  async upsertAreaEntries(provider: string, entries: AreaCacheEntry[]): Promise<AreaCache> {
    return this.withMutation(async () => {
      const areaCache = await this.readAreaCache();
      for (const entry of entries) {
        areaCache.entries[String(entry.hutId)] = { ...entry, provider };
      }
      areaCache.provider = provider;
      areaCache.refreshedAt = new Date().toISOString();
      await this.writeAreaCache(areaCache);
      return areaCache;
    });
  }

  async saveDraft(draft: DraftInput): Promise<Draft> {
    return this.withMutation(async () => {
      const cache = await this.readDraftCache();
      removeExpiredDrafts(cache, Date.now());
      const id = draft.id ?? randomUUID();
      const saved = { ...draft, id } as Draft;
      cache.drafts[id] = saved;
      cache.refreshedAt = new Date().toISOString();
      await this.writeJson("drafts.json", cache);
      return saved;
    });
  }

  async getDraft(id: string): Promise<Draft | null> {
    return this.withMutation(async () => {
      const cache = await this.readDraftCache();
      const draft = cache.drafts[id];
      if (!draft) return null;
      if (Date.parse(draft.expiresAt) <= Date.now()) {
        delete cache.drafts[id];
        cache.refreshedAt = new Date().toISOString();
        await this.writeJson("drafts.json", cache);
        return null;
      }
      return draft;
    });
  }

  async deleteDraft(id: string): Promise<void> {
    await this.withMutation(async () => {
      const cache = await this.readDraftCache();
      delete cache.drafts[id];
      cache.refreshedAt = new Date().toISOString();
      await this.writeJson("drafts.json", cache);
    });
  }

  async sweepExpiredDrafts(now = Date.now()): Promise<number> {
    return this.withMutation(async () => {
      const cache = await this.readDraftCache();
      const removed = removeExpiredDrafts(cache, now);
      if (removed > 0) {
        cache.refreshedAt = new Date().toISOString();
        await this.writeJson("drafts.json", cache);
      }
      return removed;
    });
  }

  async status(): Promise<CacheStatus> {
    const [catalog, areaCache, draftCache] = await Promise.all([
      this.readCatalog(),
      this.readAreaCache(),
      this.readDraftCache()
    ]);
    const now = Date.now();
    const drafts = Object.values(draftCache.drafts);
    const expired = drafts.filter((draft) => Date.parse(draft.expiresAt) <= now).length;
    const active = drafts.length - expired;
    const areaEntries = Object.values(areaCache.entries);
    return {
      cacheDir: this.cacheDir,
      catalog: {
        cached: catalog !== null,
        hutCount: catalog?.huts.length ?? 0,
        failureCount: catalog?.failures.length ?? 0,
        refreshedAt: catalog?.refreshedAt ?? null
      },
      areas: {
        cachedEntries: areaEntries.length,
        entriesWithCanton: areaEntries.filter((entry) => Boolean(entry.canton)).length,
        missingCanton: areaEntries.filter((entry) => !entry.canton).length,
        provider: areaCache.provider,
        refreshedAt: areaCache.refreshedAt === new Date(0).toISOString() ? null : areaCache.refreshedAt
      },
      drafts: {
        active,
        expired,
        refreshedAt: draftCache.refreshedAt === new Date(0).toISOString() ? null : draftCache.refreshedAt
      }
    };
  }

  private async readDraftCache(): Promise<DraftCache> {
    return (
      (await this.readJson<DraftCache>("drafts.json")) ?? {
        refreshedAt: new Date(0).toISOString(),
        drafts: {}
      }
    );
  }

  private async readJson<T>(fileName: string): Promise<T | null> {
    try {
      const content = await fs.readFile(path.join(this.cacheDir, fileName), "utf8");
      return JSON.parse(content) as T;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeJson(fileName: string, value: unknown): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const target = path.join(this.cacheDir, fileName);
    const temp = path.join(this.cacheDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(() => this.withFileLock(operation), () => this.withFileLock(operation));
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireFileLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const lockPath = path.join(this.cacheDir, LOCK_FILE_NAME);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString()
          })
        );
        await handle.close();
        return async () => {
          await fs.rm(lockPath, { force: true });
        };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await this.removeStaleLock(lockPath);
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for cache lock ${lockPath}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return;
      await fs.rm(lockPath, { force: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function removeExpiredDrafts(cache: DraftCache, now: number): number {
  let removed = 0;
  for (const [id, draft] of Object.entries(cache.drafts)) {
    if (Date.parse(draft.expiresAt) <= now) {
      delete cache.drafts[id];
      removed += 1;
    }
  }
  return removed;
}
