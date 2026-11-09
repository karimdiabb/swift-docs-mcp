import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDir, DocCache } from "../src/cache/cache.ts";

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let t: number;
const now = () => t;
const entry = (key = "developer.apple.com/documentation/swiftui/view", body = '{"a":1}') => ({
  key,
  url: `https://${key}`,
  body,
  etag: '"e1"',
  lastModified: "Mon, 26 Oct 2026 05:40:44 GMT",
});
const pageFiles = () => readdirSync(join(dir, "pages"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdm-cache-"));
  t = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("DocCache: basic get/set", () => {
  it("misses when empty", () => {
    expect(new DocCache({ dir, now }).get("nope")).toBeUndefined();
  });

  it("stores and returns an entry with validators and fetch time", () => {
    const c = new DocCache({ dir, now });
    c.set(entry());
    const hit = c.get(entry().key)!;
    expect(hit.fresh).toBe(true);
    expect(hit.entry).toEqual({ ...entry(), fetchedAt: t });
  });

  it("persists across instances (on disk, not in memory)", () => {
    new DocCache({ dir, now }).set(entry());
    expect(new DocCache({ dir, now }).get(entry().key)?.entry.body).toBe('{"a":1}');
  });

  it("uses hashed filenames, so keys never become paths", () => {
    const c = new DocCache({ dir, now });
    c.set(entry("../../etc/passwd"));
    const files = pageFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(c.get("../../etc/passwd")?.entry.key).toBe("../../etc/passwd");
  });

  it("replaces an existing entry", () => {
    const c = new DocCache({ dir, now });
    c.set(entry());
    c.set(entry(undefined, '{"a":2}'));
    expect(c.get(entry().key)?.entry.body).toBe('{"a":2}');
    expect(pageFiles()).toHaveLength(1);
  });
});

describe("DocCache: TTL", () => {
  it("is fresh just before the TTL and stale at it (default 7 days)", () => {
    const c = new DocCache({ dir, now });
    c.set(entry());
    t += 7 * DAY - 1;
    expect(c.get(entry().key)?.fresh).toBe(true);
    t += 1;
    const stale = c.get(entry().key)!;
    expect(stale.fresh).toBe(false);
    expect(stale.entry.etag).toBe('"e1"'); // still returned, so the caller can revalidate
  });

  it("honours a configured TTL", () => {
    const c = new DocCache({ dir, now, ttlMs: 1000 });
    c.set(entry());
    t += 1000;
    expect(c.get(entry().key)?.fresh).toBe(false);
  });

  it("touch() marks an entry fresh again after a 304 and updates validators", () => {
    const c = new DocCache({ dir, now });
    c.set(entry());
    t += 8 * DAY;
    c.touch(entry().key, { etag: '"e2"' });
    const hit = c.get(entry().key)!;
    expect(hit.fresh).toBe(true);
    expect(hit.entry.fetchedAt).toBe(t);
    expect(hit.entry.etag).toBe('"e2"');
    expect(hit.entry.body).toBe('{"a":1}');
  });

  it("touch() on a missing key does nothing", () => {
    const c = new DocCache({ dir, now });
    c.touch("missing");
    expect(c.get("missing")).toBeUndefined();
  });
});

describe("DocCache: corruption and interrupted writes", () => {
  it.each([
    ["truncated JSON", '{"key":"k","url":"u","fetchedAt":1,"bo'],
    ["empty file", ""],
    ["wrong shape", '{"hello":"world"}'],
    ["array", "[]"],
  ])("treats a %s entry as a miss and removes it", (_n, content) => {
    const c = new DocCache({ dir, now });
    c.set(entry());
    const file = join(dir, "pages", pageFiles()[0]);
    writeFileSync(file, content);
    expect(c.get(entry().key)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(c.stats().corruptRemoved).toBe(1);
  });

  it("treats an entry stored under another key (hash mismatch) as a miss", () => {
    const c = new DocCache({ dir, now });
    c.set(entry("a"));
    const file = join(dir, "pages", pageFiles()[0]);
    c.set(entry("b"));
    const other = pageFiles().map((f) => join(dir, "pages", f)).find((f) => f !== file)!;
    rmSync(other);
    // copy a's file to b's name
    writeFileSync(other, JSON.stringify({ ...entry("a"), fetchedAt: t }));
    expect(c.get("b")).toBeUndefined();
  });

  it("keeps the old entry intact when a write fails halfway", () => {
    const c = new DocCache({ dir, now });
    c.set(entry());
    const failing = new DocCache({
      dir,
      now,
      fs: {
        writeFileSync: (path: string, data: string) => {
          writeFileSync(path, data.slice(0, 5)); // partial temp file, then crash
          throw new Error("disk full");
        },
      },
    });
    expect(() => failing.set(entry(undefined, '{"a":2}'))).toThrow("disk full");
    expect(c.get(entry().key)?.entry.body).toBe('{"a":1}');
  });

  it("does not leave temp files after successful writes", () => {
    const c = new DocCache({ dir, now });
    for (let i = 0; i < 5; i++) c.set(entry(`k${i}`));
    expect(pageFiles().filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("sweeps old leftover temp files on startup but not recent ones (another process may be writing)", () => {
    new DocCache({ dir, now }).set(entry());
    const oldTmp = join(dir, "pages", "abc.json.1.old.tmp");
    const newTmp = join(dir, "pages", "abc.json.2.new.tmp");
    writeFileSync(oldTmp, "partial");
    writeFileSync(newTmp, "partial");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(oldTmp, old, old);
    new DocCache({ dir, now });
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(newTmp)).toBe(true);
  });
});

describe("DocCache: clear and stats", () => {
  it("reports entry count, bytes and age range", () => {
    const c = new DocCache({ dir, now });
    c.set(entry("a"));
    t += 1000;
    c.set(entry("b"));
    const s = c.stats();
    expect(s.entries).toBe(2);
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.oldestFetchedAt).toBe(t - 1000);
    expect(s.newestFetchedAt).toBe(t);
    expect(s.dir).toBe(join(dir, "pages"));
  });

  it("clear() removes entries and temp files and reports the count", () => {
    const c = new DocCache({ dir, now });
    c.set(entry("a"));
    c.set(entry("b"));
    writeFileSync(join(dir, "pages", "x.json.9.z.tmp"), "partial");
    expect(c.clear()).toBe(2);
    expect(pageFiles()).toHaveLength(0);
    expect(c.get("a")).toBeUndefined();
  });

  it("ignores unrelated files in the directory", () => {
    const c = new DocCache({ dir, now });
    c.set(entry("a"));
    writeFileSync(join(dir, "pages", "README.txt"), "hi");
    expect(c.stats().entries).toBe(1);
    expect(c.clear()).toBe(1);
    expect(pageFiles()).toEqual(["README.txt"]);
  });
});

describe("appDir", () => {
  it("uses ~/Library/Caches on macOS", () => {
    expect(appDir({ platform: "darwin", env: {}, home: "/Users/k" })).toBe("/Users/k/Library/Caches/swift-docs-mcp");
  });
  it("uses XDG_CACHE_HOME or ~/.cache elsewhere", () => {
    expect(appDir({ platform: "linux", env: { XDG_CACHE_HOME: "/x" }, home: "/h" })).toBe("/x/swift-docs-mcp");
    expect(appDir({ platform: "linux", env: {}, home: "/h" })).toBe("/h/.cache/swift-docs-mcp");
  });
  it("honours SWIFT_DOCS_MCP_HOME as an override", () => {
    expect(appDir({ platform: "darwin", env: { SWIFT_DOCS_MCP_HOME: "/tmp/sdm" }, home: "/Users/k" })).toBe("/tmp/sdm");
  });
  it("rejects a relative override", () => {
    expect(() => appDir({ platform: "darwin", env: { SWIFT_DOCS_MCP_HOME: "rel/dir" }, home: "/Users/k" })).toThrow();
  });
});
