// On-disk cache for fetched documentation JSON.
// - one file per entry, named by sha256(key): user input never becomes a filesystem path
// - atomic writes: write a unique temp file, then rename over the target (rename is atomic on one filesystem)
// - corrupt/partial entries are treated as misses and deleted
// - stale entries are still returned (fresh: false) so the caller can revalidate with ETag / 304
import * as nodeFs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TMP_SWEEP_AGE_MS = 5 * 60 * 1000;

export type CacheEntry = {
  key: string;
  url: string;
  fetchedAt: number;
  etag?: string;
  lastModified?: string;
  body: string;
};

export type CacheStats = {
  dir: string;
  entries: number;
  bytes: number;
  oldestFetchedAt?: number;
  newestFetchedAt?: number;
  corruptRemoved: number;
};

type Fs = { writeFileSync: (path: string, data: string, options: { mode: number }) => void };

export type CacheOptions = {
  /** Application directory; entries live in <dir>/pages */
  dir: string;
  ttlMs?: number;
  now?: () => number;
  /** Test hook to simulate write failures. */
  fs?: Partial<Fs>;
};

/** Base directory for cache and index. Only SWIFT_DOCS_MCP_HOME / XDG_CACHE_HOME are read from env. */
export function appDir(o: { platform?: string; env?: Record<string, string | undefined>; home?: string } = {}): string {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const override = env.SWIFT_DOCS_MCP_HOME;
  if (override) {
    if (!isAbsolute(override)) throw new Error("SWIFT_DOCS_MCP_HOME must be an absolute path");
    return override;
  }
  if (platform === "darwin") return join(home, "Library", "Caches", "swift-docs-mcp");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "swift-docs-mcp");
}

export class DocCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fs: Fs;
  private corruptRemoved = 0;

  constructor(o: CacheOptions) {
    this.dir = join(o.dir, "pages");
    this.ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
    this.now = o.now ?? Date.now;
    this.fs = { writeFileSync: nodeFs.writeFileSync, ...o.fs };
    nodeFs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.sweepTemp(TMP_SWEEP_AGE_MS);
  }

  get(key: string): { entry: CacheEntry; fresh: boolean } | undefined {
    const file = this.fileFor(key);
    let raw: string;
    try {
      raw = nodeFs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const entry = parseEntry(raw);
    if (!entry || entry.key !== key) {
      this.removeCorrupt(file);
      return undefined;
    }
    return { entry, fresh: this.now() - entry.fetchedAt < this.ttlMs };
  }

  set(e: Omit<CacheEntry, "fetchedAt"> & { fetchedAt?: number }): CacheEntry {
    const entry: CacheEntry = { ...e, fetchedAt: e.fetchedAt ?? this.now() };
    const file = this.fileFor(entry.key);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      this.fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
      nodeFs.renameSync(tmp, file);
    } catch (err) {
      nodeFs.rmSync(tmp, { force: true });
      throw err;
    }
    return entry;
  }

  /** After a 304: keep the body, refresh fetchedAt and any new validators. */
  touch(key: string, validators: { etag?: string; lastModified?: string } = {}) {
    const hit = this.get(key);
    if (!hit) return;
    const updates = Object.fromEntries(Object.entries(validators).filter(([, v]) => typeof v === "string")); // undefined must not erase stored validators
    this.set({ ...hit.entry, ...updates, fetchedAt: this.now() });
  }

  clear(): number {
    let n = 0;
    for (const f of this.list()) {
      nodeFs.rmSync(join(this.dir, f), { force: true });
      n++;
    }
    this.sweepTemp(0);
    return n;
  }

  stats(): CacheStats {
    const s: CacheStats = { dir: this.dir, entries: 0, bytes: 0, corruptRemoved: this.corruptRemoved };
    for (const f of this.list()) {
      const file = join(this.dir, f);
      let raw: string;
      try {
        raw = nodeFs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const e = parseEntry(raw);
      if (!e) continue;
      s.entries++;
      s.bytes += Buffer.byteLength(raw);
      s.oldestFetchedAt = Math.min(s.oldestFetchedAt ?? Infinity, e.fetchedAt);
      s.newestFetchedAt = Math.max(s.newestFetchedAt ?? -Infinity, e.fetchedAt);
    }
    return s;
  }

  private fileFor(key: string) {
    return join(this.dir, createHash("sha256").update(key).digest("hex") + ".json");
  }

  private list(): string[] {
    return nodeFs.readdirSync(this.dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
  }

  private removeCorrupt(file: string) {
    nodeFs.rmSync(file, { force: true });
    this.corruptRemoved++;
  }

  // Temp files only survive a crash mid-write. Skip recent ones: another process (e.g. the index CLI) may be writing.
  private sweepTemp(minAgeMs: number) {
    const cutoff = Date.now() - minAgeMs;
    for (const f of nodeFs.readdirSync(this.dir)) {
      if (!f.endsWith(".tmp")) continue;
      const file = join(this.dir, f);
      try {
        if (minAgeMs === 0 || nodeFs.statSync(file).mtimeMs < cutoff) nodeFs.rmSync(file, { force: true });
      } catch {}
    }
  }
}

function parseEntry(raw: string): CacheEntry | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const e = v as Record<string, unknown>;
  if (typeof e.key !== "string" || typeof e.url !== "string" || typeof e.body !== "string" || typeof e.fetchedAt !== "number") return undefined;
  if (e.etag !== undefined && typeof e.etag !== "string") return undefined;
  if (e.lastModified !== undefined && typeof e.lastModified !== "string") return undefined;
  return e as CacheEntry;
}
