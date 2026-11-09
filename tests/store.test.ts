import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseNavigator, type NavEntry } from "../src/index/navigator.ts";
import { IndexStore, IndexUnavailable } from "../src/index/store.ts";

const A = "https://developer.apple.com";
let dir: string;
let store: IndexStore;
const nav = (o: Partial<NavEntry> & { path: string; title: string }): NavEntry => ({ navType: "struct", pageKind: "api", languages: ["swift"], deprecated: false, beta: false, ...o });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdm-index-"));
  store = IndexStore.open(join(dir, "index.sqlite"));
  store.upsertRoot({ path: "/documentation/swiftui", slug: "swiftui", title: "SwiftUI", method: "navigator", status: "ok" });
  store.upsertRoot({ path: "/documentation/uikit", slug: "uikit", title: "UIKit", method: "navigator", status: "ok" });
  store.upsertRoot({ path: "/documentation/widgetkit", slug: "widgetkit", title: "WidgetKit", method: "navigator", status: "ok" });
  store.upsertEntries("/documentation/swiftui", [
    nav({ path: "/documentation/swiftui", title: "SwiftUI", navType: "module", pageKind: "collection" }),
    nav({ path: "/documentation/swiftui/view", title: "View", navType: "protocol" }),
    nav({ path: "/documentation/swiftui/navigationstack", title: "NavigationStack" }),
    nav({ path: "/documentation/swiftui/navigationview", title: "NavigationView", deprecated: true }),
    nav({ path: "/documentation/swiftui/view/onappear(perform:)", title: "func onAppear(perform: (() -> Void)?) -> some View", navType: "method" }),
    nav({ path: "/documentation/swiftui/view/frame(width:height:alignment:)", title: "func frame(width: CGFloat?, height: CGFloat?, alignment: Alignment) -> some View", navType: "method" }),
    nav({ path: "/documentation/swiftui/view/frame(minwidth:idealwidth:maxwidth:minheight:idealheight:maxheight:alignment:)", title: "func frame(minWidth: CGFloat?, ...) -> some View", navType: "method" }),
    nav({ path: "/documentation/swiftui/migrating-to-the-swiftui-life-cycle", title: "Migrating to the SwiftUI life cycle", navType: "article", pageKind: "article" }),
  ], 1000);
  store.upsertEntries("/documentation/uikit", [
    nav({ path: "/documentation/uikit/uiview", title: "UIView", navType: "class", languages: ["swift", "occ"] }),
    nav({ path: "/documentation/uikit/uinavigationcontroller", title: "UINavigationController", navType: "class" }),
  ], 1000);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("search", () => {
  it("finds a type by exact name and ranks it first", () => {
    const r = store.search("NavigationStack");
    expect(r.hits[0]).toMatchObject({ path: "/documentation/swiftui/navigationstack", url: `${A}/documentation/swiftui/navigationstack`, title: "NavigationStack", framework: "SwiftUI", pageKind: "api", navType: "struct" });
  });

  it("matches split camelCase words and prefixes", () => {
    expect(store.search("navigation stack").hits[0].path).toBe("/documentation/swiftui/navigationstack");
    expect(store.search("navig").hits.map((h) => h.path)).toContain("/documentation/uikit/uinavigationcontroller");
  });

  it("ranks an exact symbol name above a page with more term hits and a shorter path", () => {
    store.upsertRoot({ path: "/documentation/a", slug: "a", title: "A", method: "navigator", status: "ok" });
    store.upsertEntries("/documentation/a", [nav({ path: "/documentation/a/lists", title: "List of lists list", navType: "article", pageKind: "article" })], 1000);
    store.upsertEntries("/documentation/swiftui", [nav({ path: "/documentation/swiftui/list", title: "List" })], 1000);
    expect(store.search("list").hits[0].path).toBe("/documentation/swiftui/list");
  });

  it("ranks the exact title match above longer matches", () => {
    expect(store.search("view").hits[0].path).toBe("/documentation/swiftui/view");
  });

  it("pushes deprecated pages below current ones", () => {
    const paths = store.search("navigation").hits.map((h) => h.path);
    expect(paths.indexOf("/documentation/swiftui/navigationstack")).toBeLessThan(paths.indexOf("/documentation/swiftui/navigationview"));
  });

  it("finds members by symbol name", () => {
    expect(store.search("onAppear").hits[0].path).toBe("/documentation/swiftui/view/onappear(perform:)");
    expect(store.search("onAppear(perform:)").hits[0].path).toBe("/documentation/swiftui/view/onappear(perform:)");
  });

  it("filters by framework slug or title, and by kind", () => {
    expect(store.search("navigation", { framework: "UIKit" }).hits.map((h) => h.path)).toEqual(["/documentation/uikit/uinavigationcontroller"]);
    expect(store.search("navigation", { framework: "uikit" }).hits).toHaveLength(1);
    expect(store.search("swiftui", { kind: "article" }).hits.map((h) => h.path)).toEqual(["/documentation/swiftui/migrating-to-the-swiftui-life-cycle"]);
  });

  it("filters by platform only where platform data exists, and reports the unknown ones", () => {
    store.enrich("/documentation/swiftui/navigationstack", { abstract: "A view that displays a root view.", platforms: [{ platform: "iOS", introduced: "16.0" }, { platform: "tvOS", unavailable: true }], declaration: "struct NavigationStack" }, 2000);
    const ios = store.search("navigation", { platform: "ios" });
    expect(ios.hits.map((h) => h.path)).toEqual(["/documentation/swiftui/navigationstack"]);
    expect(ios.platformUnknown).toBe(2); // navigationview and uinavigationcontroller have no platform data yet
    expect(store.search("navigation", { platform: "tvOS" }).hits).toHaveLength(0); // unavailable on tvOS
  });

  it("returns enriched abstract, declaration and platforms", () => {
    store.enrich("/documentation/swiftui/navigationstack", { abstract: "A view that displays a root view.", platforms: [{ platform: "iOS", introduced: "16.0" }], declaration: "struct NavigationStack" }, 2000);
    expect(store.search("NavigationStack").hits[0]).toMatchObject({ abstract: "A view that displays a root view.", declaration: "struct NavigationStack", platforms: [{ platform: "iOS", introduced: "16.0" }] });
    expect(store.search("root view").hits[0].path).toBe("/documentation/swiftui/navigationstack"); // abstract is searchable
  });

  it("paginates with a cursor", () => {
    const p1 = store.search("view", { limit: 2 });
    expect(p1.hits).toHaveLength(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = store.search("view", { limit: 2, cursor: p1.nextCursor });
    expect(p2.hits.map((h) => h.path)).not.toContain(p1.hits[0].path);
    expect(p1.total).toBeGreaterThanOrEqual(4);
  });

  it("treats FTS syntax in the query as plain text", () => {
    for (const q of ['NEAR(view)', 'view OR "', "title:view", "*", "view^2", "-view", "(", "\u0000"]) expect(() => store.search(q)).not.toThrow();
    expect(store.search("").hits).toEqual([]);
  });

  it("falls back to any-word matching when all-words finds nothing", () => {
    const r = store.search("navigationstack zzzunknownword");
    expect(r.hits[0].path).toBe("/documentation/swiftui/navigationstack");
    expect(r.matchedAllWords).toBe(false);
  });
});

describe("findSymbol", () => {
  it("returns a single exact match", () => {
    expect(store.findSymbol("NavigationStack").map((c) => c.path)).toEqual(["/documentation/swiftui/navigationstack"]);
  });

  it("matches a base name to all its overloads (caller must disambiguate)", () => {
    expect(store.findSymbol("frame").map((c) => c.path)).toHaveLength(2);
  });

  it("narrows by parent type and framework qualifiers", () => {
    expect(store.findSymbol("View.onAppear").map((c) => c.path)).toEqual(["/documentation/swiftui/view/onappear(perform:)"]);
    expect(store.findSymbol("SwiftUI.View").map((c) => c.path)).toEqual(["/documentation/swiftui/view"]);
    expect(store.findSymbol("frame(width:height:alignment:)").map((c) => c.path)).toEqual(["/documentation/swiftui/view/frame(width:height:alignment:)"]);
    expect(store.findSymbol("View", { framework: "uikit" })).toEqual([]);
    expect(store.findSymbol("UIKit.NavigationStack")).toEqual([]);
  });

  it("ignores articles and removed pages", () => {
    expect(store.findSymbol("Migrating to the SwiftUI life cycle")).toEqual([]);
  });
});

describe("sync bookkeeping", () => {
  it("marks pages not seen in a later sync of the same root as removed, and excludes them", () => {
    store.upsertEntries("/documentation/uikit", [nav({ path: "/documentation/uikit/uiview", title: "UIView", navType: "class" })], 5000);
    expect(store.markRemovedNotSeen("/documentation/uikit", 5000, 6000)).toBe(1);
    expect(store.search("UINavigationController").hits).toHaveLength(0);
    expect(store.get("/documentation/uikit/uinavigationcontroller")?.removedAt).toBe(6000);
    expect(store.findSymbol("UINavigationController")).toEqual([]);
  });

  it("resurrects a removed page when it reappears", () => {
    store.markRemovedNotSeen("/documentation/uikit", 5000, 6000);
    store.upsertEntries("/documentation/uikit", [nav({ path: "/documentation/uikit/uiview", title: "UIView", navType: "class" })], 7000);
    expect(store.get("/documentation/uikit/uiview")?.removedAt).toBeUndefined();
    expect(store.search("UIView").hits[0].path).toBe("/documentation/uikit/uiview");
  });

  it("deduplicates: upserting the same path twice keeps one row and updates it", () => {
    store.upsertEntries("/documentation/swiftui", [nav({ path: "/documentation/swiftui/view", title: "View", navType: "protocol", deprecated: true })], 2000);
    expect(store.stats().docs).toBe(10);
    expect(store.get("/documentation/swiftui/view")?.deprecated).toBe(true);
  });

  it("keeps enrichment when the navigator upserts the page again", () => {
    store.enrich("/documentation/swiftui/view", { abstract: "A type that represents part of your app’s user interface." }, 2000);
    store.upsertEntries("/documentation/swiftui", [nav({ path: "/documentation/swiftui/view", title: "View", navType: "protocol" })], 3000);
    expect(store.get("/documentation/swiftui/view")?.abstract).toBe("A type that represents part of your app’s user interface.");
  });

  it("touchRoot marks all of a root's pages as seen (for 304 responses)", () => {
    store.touchRoot("/documentation/uikit", 9000);
    expect(store.markRemovedNotSeen("/documentation/uikit", 9000, 9500)).toBe(0);
  });

  it("does not let one root's sync remove another root's pages", () => {
    store.upsertEntries("/documentation/widgetkit", [], 5000);
    expect(store.markRemovedNotSeen("/documentation/widgetkit", 5000, 6000)).toBe(0);
    expect(store.stats().docs).toBe(10);
  });

  it("lists pages pending enrichment by kind, framework and limit", () => {
    expect(store.pendingEnrichment({ kinds: ["struct", "protocol"], limit: 10 })).toEqual(["/documentation/swiftui/view", "/documentation/swiftui/navigationview", "/documentation/swiftui/navigationstack"]); // shortest path first
    store.enrich("/documentation/swiftui/view", { abstract: "x" }, 2000);
    expect(store.pendingEnrichment({ kinds: ["protocol"], limit: 10 })).toEqual([]);
    expect(store.pendingEnrichment({ kinds: ["class"], framework: "uikit", limit: 1 })).toHaveLength(1);
  });
});

describe("roots, meta, stats, persistence", () => {
  it("stores root state with validators and errors", () => {
    store.upsertRoot({ path: "/documentation/uikit", slug: "uikit", title: "UIKit", method: "navigator", status: "ok", etag: '"e1"', checkedAt: 1, changedAt: 1 });
    store.upsertRoot({ path: "/design/human-interface-guidelines", slug: "human-interface-guidelines", title: "HIG", method: "walk", status: "error", error: "timeout" });
    expect(store.getRoot("/documentation/uikit")).toMatchObject({ etag: '"e1"', status: "ok" });
    expect(store.listRoots().find((r) => r.slug === "human-interface-guidelines")).toMatchObject({ status: "error", error: "timeout", method: "walk" });
  });

  it("reports stats", () => {
    store.enrich("/documentation/swiftui/view", { abstract: "x", platforms: [{ platform: "iOS", introduced: "13.0" }, { platform: "macOS", introduced: "10.15" }] }, 2000);
    store.setMeta("lastBuild", "123");
    const s = store.stats();
    expect(s).toMatchObject({ docs: 10, removed: 0, enriched: 1, byKind: { api: 8, collection: 1, article: 1 }, rootsTotal: 3, rootsByStatus: { ok: 3 } });
    expect(s.platforms).toEqual(["iOS", "macOS"]);
    expect(s.frameworksWithDocs).toBe(2);
    expect(store.getMeta("lastBuild")).toBe("123");
  });

  it("persists on disk", () => {
    store.close();
    store = IndexStore.open(join(dir, "index.sqlite"));
    expect(store.search("NavigationStack").hits).toHaveLength(1);
  });

  it("reports a corrupt index file as unavailable instead of crashing", () => {
    store.close();
    const f = join(dir, "bad.sqlite");
    writeFileSync(f, "this is not a database".repeat(100));
    expect(() => IndexStore.open(f)).toThrow(IndexUnavailable);
    store = IndexStore.open(join(dir, "index.sqlite"));
  });

  it("opens read-only without creating a missing file", () => {
    expect(() => IndexStore.open(join(dir, "missing.sqlite"), { readOnly: true })).toThrow(IndexUnavailable);
  });

  it("refuses an index with a different schema version", () => {
    store.setMeta("schemaVersion", "999");
    store.close();
    expect(() => IndexStore.open(join(dir, "index.sqlite"))).toThrow(/schema/);
    // reopen for afterEach
    const db = readFileSync(join(dir, "index.sqlite"));
    expect(db.length).toBeGreaterThan(0);
    store = IndexStore.open(join(dir, "fresh.sqlite"));
  });
});
