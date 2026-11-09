import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocCache } from "../src/cache/cache.ts";
import { IndexStore } from "../src/index/store.ts";
import { buildStatus, renderStatus } from "../src/status.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "sdm-status-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("status", () => {
  it("reports a missing index honestly and says how to build it", () => {
    const s = buildStatus({ store: undefined, storeError: "no index at /x/index.sqlite; run the index build command first", cache: new DocCache({ dir }), recentErrors: [] });
    expect(s.index.available).toBe(false);
    const md = renderStatus(s);
    expect(md).toContain("Index: not available");
    expect(md).toContain("swift-docs-mcp index build");
    expect(md).not.toMatch(/complete coverage/i);
  });

  it("reports counts, freshness, roots with problems, gaps and recent errors", () => {
    const store = IndexStore.open(join(dir, "index.sqlite"));
    store.upsertRoot({ path: "/documentation/swiftui", slug: "swiftui", title: "SwiftUI", method: "navigator", status: "ok", docCount: 2 });
    store.upsertRoot({ path: "/design/human-interface-guidelines", slug: "human-interface-guidelines", title: "HIG", method: "walk", status: "partial", error: "walk limit of 3000 pages reached" });
    store.upsertRoot({ path: "/documentation/xcode", slug: "xcode", title: "Xcode", method: "navigator", status: "error", error: "timeout" });
    store.upsertEntries("/documentation/swiftui", [
      { path: "/documentation/swiftui/view", title: "View", navType: "protocol", pageKind: "api", languages: ["swift"], deprecated: false, beta: false },
      { path: "/documentation/swiftui/text", title: "Text", navType: "struct", pageKind: "api", languages: ["swift"], deprecated: false, beta: false },
    ], 1000);
    store.enrich("/documentation/swiftui/view", { abstract: "x", platforms: [{ platform: "iOS", introduced: "13.0" }] }, 2000);
    store.setMeta("lastBuild", String(Date.UTC(2026, 10, 9)));
    store.setMeta("syncState", "partial");
    const s = buildStatus({ store, cache: new DocCache({ dir }), recentErrors: ["get_apple_doc: timeout (https://developer.apple.com/tutorials/data/x.json)"] });
    const md = renderStatus(s);
    expect(md).toContain("Search: local index (SQLite FTS5)");
    expect(md).toContain("Pages indexed: 2");
    expect(md).toContain("With abstract/platform data: 1 (50%)");
    expect(md).toContain("Last build: 2026-11-09T00:00:00.000Z");
    expect(md).toContain("Last sync state: partial");
    expect(md).toMatch(/HIG.*partial.*walk limit/);
    expect(md).toMatch(/Xcode.*error.*timeout/);
    expect(md).toContain("Platforms seen in enriched pages: iOS");
    expect(md).toContain("get_apple_doc: timeout");
    expect(md).toContain("Known gaps");
    expect(md).toMatch(/not a verified complete inventory/i);
    store.close();
  });

  it("flags an interrupted sync", () => {
    const store = IndexStore.open(join(dir, "index.sqlite"));
    store.setMeta("syncState", "running");
    expect(renderStatus(buildStatus({ store, cache: new DocCache({ dir }), recentErrors: [] }))).toMatch(/running or was interrupted/);
    store.close();
  });
});
