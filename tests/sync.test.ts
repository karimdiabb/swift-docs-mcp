import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppleClient, type FetchLike } from "../src/apple/client.ts";
import { DocService } from "../src/apple/docs.ts";
import { DocCache } from "../src/cache/cache.ts";
import { Indexer } from "../src/index/sync.ts";
import { IndexStore } from "../src/index/store.ts";

// ---- a small fake developer.apple.com ----
const WIDGETKIT = JSON.parse(readFileSync(new URL("./fixtures/navigator-widgetkit.json", import.meta.url), "utf8"));
const WIDGETKIT_COUNT = 329; // computed independently in navigator.test.ts
const SWIFTORG = JSON.parse(readFileSync(new URL("./fixtures/navigator-swiftorg.json", import.meta.url), "utf8")); // book 44, API Guidelines 33, Standard Library stub 4

type Site = Map<string, { body: unknown; etag: string } | number>;
const page = (path: string, title: string, refs: string[] = [], o: { role?: string; kind?: string } = {}) => ({
  metadata: { title, role: o.role ?? "article", platforms: [{ name: "iOS", introducedAt: "17.0" }] },
  identifier: { url: `doc://x${path}`, interfaceLanguage: "swift" },
  kind: o.kind ?? "article",
  abstract: [{ type: "text", text: `About ${title}` }],
  topicSections: [{ title: "Topics", identifiers: refs.map((r) => `doc://x${r}`) }],
  references: Object.fromEntries(refs.map((r) => [`doc://x${r}`, { type: "topic", title: r, url: r, identifier: `doc://x${r}` }])),
});
const technologies = (urls: [string, string][]) => ({
  metadata: { title: "Technologies", role: "overview" },
  identifier: { url: "doc://x/documentation/technologies" },
  kind: "article",
  references: {
    ...Object.fromEntries(urls.map(([url, title]) => [`doc://t${url}`, { type: "topic", url, title, role: "collection", identifier: `doc://t${url}` }])),
    img: { type: "image", identifier: "img", variants: [] },
  },
});
const HIG = "/design/human-interface-guidelines";
function baseSite(): Site {
  const s: Site = new Map();
  const put = (path: string, body: unknown, etag = '"1"') => s.set(path, { body, etag });
  put("/tutorials/data/documentation/technologies.json", technologies([["/documentation/widgetkit", "WidgetKit"], [HIG, "Human Interface Guidelines"]]));
  put("/tutorials/data/index/widgetkit", WIDGETKIT, '"w1"');
  // HIG has no navigator index (404) -> walked via topicSections
  put(`/tutorials/data${HIG}.json`, page(HIG, "Human Interface Guidelines", [`${HIG}/getting-started`, `${HIG}/foundations`], { role: "collection" }));
  put(`/tutorials/data${HIG}/getting-started.json`, page(`${HIG}/getting-started`, "Getting started", [`${HIG}/getting-started/ios`, "/documentation/swiftui/view", "/tutorials/foo"]));
  put(`/tutorials/data${HIG}/foundations.json`, page(`${HIG}/foundations`, "Foundations"));
  put(`/tutorials/data${HIG}/getting-started/ios.json`, page(`${HIG}/getting-started/ios`, "Designing for iOS"));
  // a tutorial root discovered through a link
  put("/tutorials/data/tutorials/foo.json", page("/tutorials/foo", "Foo tutorials", ["/tutorials/foo/lesson-1"], { kind: "overview", role: "overview" }));
  put("/tutorials/data/tutorials/foo/lesson-1.json", page("/tutorials/foo/lesson-1", "Lesson 1", [], { kind: "project", role: "project" }));
  return s;
}

let dir: string;
let t: number;
let site: Site;
let calls: { path: string; headers: Record<string, string> }[];
let store: IndexStore;
let fallback: ((path: string) => Response | undefined) | undefined;

const fetch: FetchLike = async (url, init) => {
  const path = new URL(url).pathname;
  const headers = Object.fromEntries(new Headers(init.headers));
  calls.push({ path, headers });
  const e = site.get(path);
  if (e === undefined) return fallback?.(path) ?? new Response("<html>", { status: 404, headers: { "content-type": "text/html" } });
  if (typeof e === "number") return new Response("", { status: e });
  if (headers["if-none-match"] === e.etag) return new Response(null, { status: 304, headers: { etag: e.etag } });
  return new Response(JSON.stringify(e.body), { status: 200, headers: { "content-type": "application/json", etag: e.etag } });
};

function indexer(extra: Partial<ConstructorParameters<typeof Indexer>[0]> = {}) {
  const now = () => t;
  const client = new AppleClient({ fetch, now, sleep: async () => {}, minIntervalMs: 0 });
  const docs = new DocService({ client, cache: new DocCache({ dir, now }), now });
  return new Indexer({ client, docs, store, now, log: () => {}, ...extra });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdm-sync-"));
  t = Date.UTC(2026, 10, 9);
  site = baseSite();
  calls = [];
  fallback = undefined;
  store = IndexStore.open(join(dir, "index.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const removeNode = (tree: any, path: string): any => JSON.parse(JSON.stringify(tree), (k, v) => (Array.isArray(v) ? v.filter((n) => n?.path?.toLowerCase() !== path) : v));

describe("Indexer.sync build", () => {
  it("indexes navigator roots, walks roots without an index, and discovers tutorial roots", async () => {
    const r = await indexer().sync({ mode: "build" });
    expect(store.stats().docs).toBe(WIDGETKIT_COUNT + 4 + 2);
    expect(r.partial).toBe(false);
    expect(r.errors).toEqual([]);
    expect(store.getRoot("/documentation/widgetkit")).toMatchObject({ method: "navigator", status: "ok", etag: '"w1"', docCount: WIDGETKIT_COUNT });
    expect(store.getRoot(HIG)).toMatchObject({ method: "walk", status: "ok", docCount: 4 });
    expect(store.getRoot("/tutorials/foo")).toMatchObject({ method: "walk", status: "ok", docCount: 2 });
    expect(store.getMeta("syncState")).toBe("complete");
    expect(store.getMeta("lastBuild")).toBe(String(t));
  });

  it("logs progress: a counter per root and a line when a walk starts", async () => {
    const lines: string[] = [];
    await indexer({ log: (m) => lines.push(m) }).sync({ mode: "build" });
    expect(lines.some((l) => /^\s*\[1\/\d+\] /.test(l))).toBe(true);
    expect(lines.some((l) => /walking \/design\/human-interface-guidelines/.test(l))).toBe(true);
  });

  it("stores walked pages with their metadata (abstract, platforms, kind)", async () => {
    await indexer().sync({ mode: "build" });
    expect(store.get(`${HIG}/foundations`)).toMatchObject({ title: "Foundations", pageKind: "guideline", abstract: "About Foundations", platforms: [{ platform: "iOS", introduced: "17.0" }] });
    expect(store.get("/tutorials/foo/lesson-1")?.pageKind).toBe("tutorial");
    expect(store.get("/documentation/swiftui/view")).toBeUndefined(); // outside the walked root
  });

  it("makes the corpus searchable", async () => {
    await indexer().sync({ mode: "build" });
    expect(store.search("TimelineProvider").hits[0].path).toBe("/documentation/widgetkit/timelineprovider");
    expect(store.search("designing ios").hits[0].path).toBe(`${HIG}/getting-started/ios`);
  });

  it("fails the build when technologies.json cannot be fetched", async () => {
    site.set("/tutorials/data/documentation/technologies.json", 500);
    await expect(indexer().sync({ mode: "build" })).rejects.toThrow(/technologies/);
  });
});

describe("Indexer.sync refresh", () => {
  it("uses conditional requests and changes nothing when Apple reports no changes", async () => {
    await indexer().sync({ mode: "build" });
    t += 60_000;
    calls = [];
    const r = await indexer().sync({ mode: "refresh" });
    expect(calls.find((c) => c.path === "/tutorials/data/index/widgetkit")?.headers["if-none-match"]).toBe('"w1"');
    expect(calls.find((c) => c.path === "/tutorials/data/documentation/technologies.json")?.headers["if-none-match"]).toBe('"1"');
    expect(calls.filter((c) => c.path.startsWith(`/tutorials/data${HIG}/`))).toHaveLength(0); // walked pages still fresh in cache
    expect(r.removed).toBe(0);
    expect(store.stats().docs).toBe(WIDGETKIT_COUNT + 6);
    expect(store.getMeta("lastRefresh")).toBe(String(t));
  });

  it("marks pages removed when they disappear from a changed index", async () => {
    await indexer().sync({ mode: "build" });
    t += 60_000;
    site.set("/tutorials/data/index/widgetkit", { body: removeNode(WIDGETKIT, "/documentation/widgetkit/wgwidgetuserinfokeyfamily"), etag: '"w2"' });
    const r = await indexer().sync({ mode: "refresh" });
    expect(r.removed).toBe(1);
    expect(store.get("/documentation/widgetkit/wgwidgetuserinfokeyfamily")?.removedAt).toBe(t);
    expect(store.getRoot("/documentation/widgetkit")?.etag).toBe('"w2"');
  });

  it("refuses to remove more than half of a root's pages (likely a truncated index)", async () => {
    await indexer().sync({ mode: "build" });
    t += 60_000;
    const tiny = { interfaceLanguages: { swift: [{ type: "module", title: "WidgetKit", path: "/documentation/widgetkit" }] } };
    site.set("/tutorials/data/index/widgetkit", { body: tiny, etag: '"w3"' });
    const r = await indexer().sync({ mode: "refresh" });
    expect(r.removed).toBe(0);
    expect(store.stats().docs).toBe(WIDGETKIT_COUNT + 6);
    expect(store.getRoot("/documentation/widgetkit")).toMatchObject({ status: "partial" });
    expect(store.getRoot("/documentation/widgetkit")?.error).toMatch(/refus/i);
    expect(r.partial).toBe(true);
  });

  it("keeps a root's pages when its index cannot be fetched, and reports the error", async () => {
    await indexer().sync({ mode: "build" });
    t += 60_000;
    site.set("/tutorials/data/index/widgetkit", 503);
    const r = await indexer().sync({ mode: "refresh" });
    expect(store.getRoot("/documentation/widgetkit")).toMatchObject({ status: "error" });
    expect(store.stats().docs).toBe(WIDGETKIT_COUNT + 6);
    expect(r.errors.join("\n")).toMatch(/widgetkit.*503/);
  });

  it("removes a root and its pages when Apple stops listing it", async () => {
    await indexer().sync({ mode: "build" });
    t += 60_000;
    site.set("/tutorials/data/documentation/technologies.json", { body: technologies([["/documentation/widgetkit", "WidgetKit"]]), etag: '"2"' });
    await indexer().sync({ mode: "refresh" });
    expect(store.getRoot(HIG)?.status).toBe("removed");
    expect(store.search("Foundations").hits.map((h) => h.path)).not.toContain(`${HIG}/foundations`);
  });

  it("continues with the stored root list when technologies.json fails during refresh", async () => {
    await indexer().sync({ mode: "build" });
    t += 60_000;
    site.set("/tutorials/data/documentation/technologies.json", 500);
    const r = await indexer().sync({ mode: "refresh" });
    expect(r.errors.join("\n")).toMatch(/technologies/);
    expect(store.getRoot(HIG)?.status).toBe("ok");
  });

  it("only syncs the requested roots", async () => {
    await indexer().sync({ mode: "build" });
    calls = [];
    await indexer().sync({ mode: "refresh", only: ["widgetkit"] });
    expect(calls.map((c) => c.path).filter((p) => p.includes("/index/"))).toEqual(["/tutorials/data/index/widgetkit"]);
  });

  it("marks a walk that hits the page limit as partial and removes nothing", async () => {
    const r = await indexer().sync({ mode: "build", maxWalkPages: 2 });
    expect(store.getRoot(HIG)).toMatchObject({ status: "partial" });
    expect(store.getRoot(HIG)?.error).toMatch(/limit/);
    expect(r.partial).toBe(true);
  });

  it("leaves syncState 'running' if a sync is interrupted", async () => {
    await expect(indexer({ log: () => { throw new Error("killed"); } }).sync({ mode: "build" })).rejects.toThrow("killed");
    expect(store.getMeta("syncState")).toBe("running");
  });
});

describe("Indexer.enrich", () => {
  beforeEach(() => {
    fallback = (path) => {
      const m = path.match(/^\/tutorials\/data(\/documentation\/widgetkit\/[^/]+)\.json$/);
      if (!m) return undefined;
      if (m[1].endsWith("/timelineentry")) return new Response("<html>", { status: 404, headers: { "content-type": "text/html" } });
      const body = page(m[1], m[1].split("/").pop()!, [], { role: "symbol", kind: "symbol" });
      (body as any).primaryContentSections = [{ kind: "declarations", declarations: [{ languages: ["swift"], platforms: ["iOS"], tokens: [{ kind: "keyword", text: "protocol" }, { kind: "text", text: " X" }] }] }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
  });

  it("fills abstract, platforms and declaration for pending pages of the given kinds", async () => {
    await indexer().sync({ mode: "build" });
    const r = await indexer().enrich({ kinds: ["protocol"], max: 3 });
    // shortest pending protocols: timelineentry (404 in this fake), relevanceentry, timelineprovider
    expect(r).toMatchObject({ enriched: 2, failed: 1, notFound: 1 });
    for (const p of ["/documentation/widgetkit/relevanceentry", "/documentation/widgetkit/timelineprovider"]) {
      expect(store.get(p)).toMatchObject({ declaration: "protocol X", platforms: [{ platform: "iOS", introduced: "17.0" }] });
    }
    expect(store.get("/documentation/widgetkit/timelineentry")?.declaration).toBeUndefined();
  });

  it("counts pages that no longer exist and does not retry them", async () => {
    await indexer().sync({ mode: "build" });
    const before = store.pendingEnrichment({ kinds: ["protocol"], limit: 100 });
    const r = await indexer().enrich({ kinds: ["protocol"], max: 100 });
    expect(r.enriched + r.failed).toBe(before.length);
    expect(r.notFound).toBe(before.filter((p) => p.endsWith("/timelineentry")).length);
    expect(store.pendingEnrichment({ kinds: ["protocol"], limit: 100 })).toEqual([]);
  });
});

describe("Indexer.sync with docs.swift.org", () => {
  const TSPL = "/latest/documentation/the-swift-programming-language";
  beforeEach(() => {
    site.set("/latest/index/index.json", { body: SWIFTORG, etag: '"s1"' });
    // Apple has its own Standard Library root, so swift.org's copy must be skipped.
    site.set("/tutorials/data/documentation/technologies.json", { body: technologies([["/documentation/widgetkit", "WidgetKit"], [HIG, "Human Interface Guidelines"], ["/documentation/swift", "Swift"]]), etag: '"1"' });
    site.set("/tutorials/data/index/swift", { body: { interfaceLanguages: { swift: [{ type: "module", title: "Swift", path: "/documentation/swift", children: [{ type: "struct", title: "String", path: "/documentation/swift/string" }] }] } }, etag: '"sw"' });
  });

  it("indexes swift.org collections as their own roots and skips ones Apple already has", async () => {
    const r = await indexer().sync({ mode: "build", swiftOrg: true });
    expect(r.errors).toEqual([]);
    expect(store.getRoot(TSPL)).toMatchObject({ title: "The Swift Programming Language", role: "swift.org", status: "ok", docCount: 44 });
    expect(store.getRoot("/latest/documentation/apiguidelines")).toMatchObject({ docCount: 33 });
    expect(store.getRoot("/latest/documentation/swift")).toBeUndefined();
    expect(store.stats().docs).toBe(WIDGETKIT_COUNT + 6 + 2 + 44 + 33);
  });

  it("makes book pages searchable with docs.swift.org URLs and filterable by collection", async () => {
    await indexer().sync({ mode: "build", swiftOrg: true });
    const hit = store.search("The Basics").hits[0];
    expect(hit.url).toBe(`https://docs.swift.org${TSPL}/thebasics`);
    expect(hit.framework).toBe("The Swift Programming Language");
    expect(store.search("basics", { framework: "the-swift-programming-language" }).hits[0].url).toBe(`https://docs.swift.org${TSPL}/thebasics`);
  });

  it("refreshes the shared swift.org index with one conditional request", async () => {
    await indexer().sync({ mode: "build", swiftOrg: true });
    t += 60_000;
    calls = [];
    const r = await indexer().sync({ mode: "refresh", swiftOrg: true });
    const c = calls.filter((x) => x.path === "/latest/index/index.json");
    expect(c).toHaveLength(1);
    expect(c[0].headers["if-none-match"]).toBe('"s1"');
    expect(r.removed).toBe(0);
    expect(store.getRoot(TSPL)?.docCount).toBe(44);
  });

  it("removes a collection that swift.org stops listing", async () => {
    await indexer().sync({ mode: "build", swiftOrg: true });
    t += 60_000;
    const fewer = JSON.parse(JSON.stringify(SWIFTORG));
    fewer.interfaceLanguages.swift[0].children = fewer.interfaceLanguages.swift[0].children.filter((c: any) => c.path !== "/documentation/apiguidelines");
    site.set("/latest/index/index.json", { body: fewer, etag: '"s2"' });
    const r = await indexer().sync({ mode: "refresh", swiftOrg: true });
    expect(store.getRoot("/latest/documentation/apiguidelines")?.status).toBe("removed");
    expect(r.removed).toBe(33);
  });

  it("keeps swift.org pages and reports the error when the index cannot be fetched", async () => {
    await indexer().sync({ mode: "build", swiftOrg: true });
    t += 60_000;
    site.set("/latest/index/index.json", 503);
    const r = await indexer().sync({ mode: "refresh", swiftOrg: true });
    expect(r.errors.join("\n")).toMatch(/swift\.org.*503/);
    expect(store.getRoot(TSPL)?.docCount).toBe(44);
    expect(store.stats().docs).toBe(WIDGETKIT_COUNT + 6 + 2 + 44 + 33);
  });

  it("only: ['swift.org'] syncs just swift.org", async () => {
    await indexer().sync({ mode: "build", swiftOrg: true });
    calls = [];
    await indexer().sync({ mode: "refresh", swiftOrg: true, only: ["swift.org"] });
    expect(calls.map((c) => c.path).filter((p) => p.includes("/index/"))).toEqual(["/latest/index/index.json"]);
  });
});
