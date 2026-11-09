// Opt-in (`npm run test:integration`): representative pages across many framework families, a small real
// index built from Apple's catalog, and the built server over stdio. Expected values come from Apple's JSON
// fetched in the same run, never from hardcoded snapshots.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { AppleClient } from "../../src/apple/client.ts";
import { DocService } from "../../src/apple/docs.ts";
import { DocCache } from "../../src/cache/cache.ts";
import { Indexer } from "../../src/index/sync.ts";
import { IndexStore } from "../../src/index/store.ts";
import { parseDocUrl } from "../../src/security/url.ts";

const enabled = process.env.RUN_INTEGRATION === "1";
const A = "https://developer.apple.com";
const dir = mkdtempSync(join(tmpdir(), "sdm-breadth-"));
const client = new AppleClient({ minIntervalMs: 1000 });
const cache = new DocCache({ dir });
const docs = new DocService({ client, cache });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const declOf = (json: any): string[] =>
  (json.primaryContentSections ?? []).filter((s: any) => s.kind === "declarations").flatMap((s: any) => s.declarations.map((d: any) => d.tokens.map((t: any) => t.text).join("")));

// family, URL, expected page kind
const PAGES: [string, string, string][] = [
  ["Swift standard library", "/documentation/swift/array", "api"],
  ["SwiftUI", "/documentation/swiftui/list", "api"],
  ["UIKit", "/documentation/uikit/uiviewcontroller", "api"],
  ["AppKit", "/documentation/appkit/nswindow", "api"],
  ["Foundation", "/documentation/foundation/jsondecoder", "api"],
  ["Observation", "/documentation/observation/observable()", "api"],
  ["Combine", "/documentation/combine/publisher", "api"],
  ["SwiftData", "/documentation/swiftdata/modelcontainer", "api"],
  ["StoreKit", "/documentation/storekit/product", "api"],
  ["WidgetKit", "/documentation/widgetkit/timelineprovider", "api"],
  ["MapKit", "/documentation/mapkit/mkmapview", "api"],
  ["AVFoundation", "/documentation/avfoundation/avplayer", "api"],
  ["Metal", "/documentation/metal/mtldevice", "api"],
  ["Core Location", "/documentation/corelocation/cllocationmanager", "api"],
  ["CryptoKit", "/documentation/cryptokit/sha256", "api"],
  ["Article", "/documentation/swiftui/migrating-to-the-swiftui-life-cycle", "article"],
  ["Sample code", "/documentation/metal/drawing-a-triangle-with-metal-4", "sampleCode"],
  ["Human Interface Guidelines", "/design/human-interface-guidelines/color", "guideline"],
  ["Tutorial", "/tutorials/swiftui/creating-and-combining-views", "tutorial"],
];

describe.skipIf(!enabled)("breadth across framework families", () => {
  it.each(PAGES)("%s: %s", async (_family, path, kind) => {
    const url = A + path;
    const raw = await client.getJson(parseDocUrl(url).dataUrl);
    if (raw.status !== 200) throw new Error(`unexpected ${raw.status}`);
    const json: any = raw.data;
    const r = await docs.getDoc(url, { maxRelated: 5 });
    expect(r.page.title).toBe(json.metadata.title);
    expect(r.page.url).toBe(url);
    expect(r.page.pageKind).toBe(kind);
    expect(r.page.declarations.map((d) => d.code)).toEqual(declOf(json));
    if (kind === "api") expect(r.page.declarations.length).toBeGreaterThan(0);
    expect(r.page.availability.length).toBe((json.metadata.platforms ?? []).length);
    expect(r.page.unsupported).toEqual([]); // every content type on these pages is rendered natively
    expect(r.markdown.length).toBeGreaterThan(300);
  });
});

describe.skipIf(!enabled)("real index from Apple's catalog (two roots)", () => {
  const store = IndexStore.open(join(dir, "index.sqlite"));
  afterAll(() => store.close());

  it("builds, searches and resolves symbols", async () => {
    const r = await new Indexer({ client, docs, store, log: () => {} }).sync({ mode: "build", only: ["swiftui", "foundation"] });
    expect(r.roots.filter((x) => x.status === "ok").map((x) => x.path).sort()).toEqual(["/documentation/foundation", "/documentation/swiftui"]);
    expect(store.stats().docs).toBeGreaterThan(5000);
    expect(store.search("NavigationStack").hits[0].url).toBe(`${A}/documentation/swiftui/navigationstack`);
    expect(store.search("JSONDecoder").hits[0].url).toBe(`${A}/documentation/foundation/jsondecoder`);
    expect(store.search("navigation stack").hits.slice(0, 3).map((h) => h.url)).toContain(`${A}/documentation/swiftui/navigationstack`);
    // The bare name is genuinely ambiguous on Apple's site (ToolbarRole.navigationStack also exists); qualified is exact.
    expect(store.findSymbol("NavigationStack").map((c) => c.path)[0]).toBe("/documentation/swiftui/navigationstack");
    expect(store.findSymbol("SwiftUI.NavigationStack").map((c) => c.path)).toEqual(["/documentation/swiftui/navigationstack"]);
    expect(store.findSymbol("View.onAppear").length).toBeGreaterThan(0);
  }, 120_000);

  it("refreshes with conditional requests and finds nothing removed", async () => {
    const r = await new Indexer({ client, docs, store, log: () => {} }).sync({ mode: "refresh", only: ["swiftui", "foundation"] });
    expect(r.roots.every((x) => x.changed === false)).toBe(true); // both answered 304
    expect(r.removed).toBe(0);
  }, 60_000);
});

const dist = new URL("../../dist/index.js", import.meta.url).pathname;
describe.skipIf(!enabled || !existsSync(dist))("built server over stdio (as Claude Desktop runs it)", () => {
  it("retrieves a real page through get_apple_doc", async () => {
    const home = mkdtempSync(join(tmpdir(), "sdm-dist-"));
    const c = new Client({ name: "integration", version: "1" });
    try {
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [dist], env: { ...process.env, SWIFT_DOCS_MCP_HOME: home } as Record<string, string>, stderr: "pipe" }));
      const r: any = await c.callTool({ name: "get_apple_doc", arguments: { url: `${A}/documentation/swiftui/navigationstack`, max_related: 3 } });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("# NavigationStack");
      expect(r.content[0].text).toContain("struct NavigationStack");
    } finally {
      await c.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
