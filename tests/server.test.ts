import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppleClient, type FetchLike } from "../src/apple/client.ts";
import { DocService } from "../src/apple/docs.ts";
import { DocCache } from "../src/cache/cache.ts";
import { IndexStore } from "../src/index/store.ts";
import { createServer } from "../src/server.ts";

const A = "https://developer.apple.com";
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");
const PAGES: Record<string, string> = {
  "/tutorials/data/documentation/swiftui/navigationstack.json": fx("struct"),
  "/tutorials/data/documentation/swiftui/view.json": fx("protocol"),
  "/tutorials/data/documentation/swift/int/+(_:_:).json": fx("op"),
};

let dir: string;
let calls: string[];
let store: IndexStore | undefined;
let client: Client;
let online: boolean;

const fetch: FetchLike = async (url) => {
  const path = decodeURI(new URL(url).pathname);
  calls.push(path);
  if (!online) throw new TypeError("fetch failed");
  const body = PAGES[path];
  return body ? new Response(body, { status: 200, headers: { "content-type": "application/json" } }) : new Response("<html>", { status: 404, headers: { "content-type": "text/html" } });
};

const nav = (path: string, title: string, navType = "struct", pageKind = "api") => ({ path, title, navType, pageKind: pageKind as any, languages: ["swift"], deprecated: false, beta: false });

async function connect(withIndex = true) {
  if (withIndex) {
    store = IndexStore.open(join(dir, "index.sqlite"));
    store.upsertRoot({ path: "/documentation/swiftui", slug: "swiftui", title: "SwiftUI", method: "navigator", status: "ok" });
    store.upsertRoot({ path: "/documentation/swift", slug: "swift", title: "Swift", method: "navigator", status: "ok" });
    store.upsertEntries("/documentation/swiftui", [
      nav("/documentation/swiftui/navigationstack", "NavigationStack"),
      nav("/documentation/swiftui/view", "View", "protocol"),
      nav("/documentation/swiftui/view/frame(width:height:alignment:)", "func frame(width:height:alignment:)", "method"),
      nav("/documentation/swiftui/view/frame(minwidth:idealwidth:maxwidth:minheight:idealheight:maxheight:alignment:)", "func frame(minWidth:...)", "method"),
      nav("/documentation/swiftui/migrating-to-the-swiftui-life-cycle", "Migrating to the SwiftUI life cycle", "article", "article"),
    ], 1000);
    store.upsertEntries("/documentation/swift", [nav("/documentation/swift/int/+(_:_:)", "static func + (Int, Int) -> Int", "op")], 1000);
    store.setMeta("lastBuild", String(Date.UTC(2026, 10, 9)));
  }
  const cache = new DocCache({ dir });
  const docs = new DocService({ client: new AppleClient({ fetch, minIntervalMs: 0, sleep: async () => {} }), cache });
  const server = createServer({ docs, cache, indexFile: join(dir, "index.sqlite"), ...(store ? { store } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: (r.content ?? []).map((c: any) => c.text).join("\n") };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdm-server-"));
  calls = [];
  online = true;
  store = undefined;
});
afterEach(async () => {
  await client?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP initialization and tool discovery", () => {
  it("lists exactly the four read-only tools with descriptions and strict schemas", async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_apple_api_details", "get_apple_doc", "get_apple_docs_status", "search_apple_docs"]);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect((t.inputSchema as any).additionalProperties).toBe(false);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    const search = tools.find((t) => t.name === "search_apple_docs")!;
    expect((search.inputSchema as any).required).toEqual(["query"]);
  });

  it("reports server name and version", async () => {
    await connect();
    expect(client.getServerVersion()).toMatchObject({ name: "swift-docs-mcp" });
  });
});

describe("input validation", () => {
  it.each([
    ["search_apple_docs", {}],
    ["search_apple_docs", { query: "" }],
    ["search_apple_docs", { query: "x".repeat(500) }],
    ["search_apple_docs", { query: "view", limit: 31 }],
    ["search_apple_docs", { query: "view", limit: 0 }],
    ["search_apple_docs", { query: "view", platform: "android" }],
    ["search_apple_docs", { query: "view", kind: "video" }],
    ["search_apple_docs", { query: "view", extra: 1 }],
    ["get_apple_doc", {}],
    ["get_apple_doc", { url: 42 }],
    ["get_apple_doc", { url: `${A}/documentation/swiftui/view`, max_related: 99 }],
    ["get_apple_api_details", {}],
    ["get_apple_docs_status", { anything: true }],
  ])("%s rejects %j", async (name, args) => {
    let failed = false;
    try {
      failed = (await call(name, args)).isError;
    } catch {
      failed = true; // protocol-level invalid params
    }
    expect(failed).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("search_apple_docs", () => {
  it("returns ranked results with URL, kind and framework, labelled as local index results", async () => {
    await connect();
    const r = await call("search_apple_docs", { query: "NavigationStack" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`1. **NavigationStack**`);
    expect(r.text).toContain(`${A}/documentation/swiftui/navigationstack`);
    expect(r.text).toContain("API reference · SwiftUI");
    expect(r.text).toMatch(/local index/i);
    expect(calls).toHaveLength(0); // search never calls Apple
  });

  it("applies kind and framework filters", async () => {
    await connect();
    const r = await call("search_apple_docs", { query: "swiftui", kind: "article" });
    expect(r.text).toContain("Migrating to the SwiftUI life cycle");
    expect(r.text).not.toContain("NavigationStack");
    expect((await call("search_apple_docs", { query: "view", framework: "swift" })).text).toMatch(/No results/);
  });

  it("explains that platform filtering only covers pages with platform data", async () => {
    await connect();
    const r = await call("search_apple_docs", { query: "navigationstack", platform: "iOS" });
    expect(r.text).toMatch(/without platform data/);
  });

  it("paginates with a cursor", async () => {
    await connect();
    const p1 = await call("search_apple_docs", { query: "frame", limit: 1 });
    const cursor = p1.text.match(/cursor: "([^"]+)"/)?.[1];
    expect(cursor).toBeDefined();
    const p2 = await call("search_apple_docs", { query: "frame", limit: 1, cursor });
    expect(p2.text).not.toBe(p1.text);
  });

  it("says clearly when the index has not been built", async () => {
    await connect(false);
    const r = await call("search_apple_docs", { query: "view" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/index build/);
    expect(r.text).toMatch(/get_apple_doc/);
  });
});

describe("get_apple_doc", () => {
  it("returns the full page as Markdown and enriches the index", async () => {
    await connect();
    const r = await call("get_apple_doc", { url: `${A}/documentation/swiftui/navigationstack` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("# NavigationStack");
    expect(r.text).toContain("nonisolated struct NavigationStack<Data, Root> where Root : View");
    expect(r.text).toMatch(/not instructions/);
    expect(store!.get("/documentation/swiftui/navigationstack")?.declaration).toBe("nonisolated struct NavigationStack<Data, Root> where Root : View");
  });

  it("caps related items and can omit them", async () => {
    await connect();
    const capped = await call("get_apple_doc", { url: `${A}/documentation/swiftui/view`, max_related: 2 });
    expect(capped.text).toContain("…and 156 more");
    const none = await call("get_apple_doc", { url: `${A}/documentation/swiftui/view`, include_related: false });
    expect(none.text).not.toContain("## Relationships");
  });

  it("rejects non-Apple and disallowed URLs without fetching", async () => {
    await connect();
    for (const url of ["https://example.com/documentation/x", `${A}/search/?q=x`, "file:///etc/passwd", `${A}/documentation/../../etc`]) {
      const r = await call("get_apple_doc", { url });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/rejected/i);
    }
    expect(calls).toHaveLength(0);
  });

  it("reports 404 and network failures honestly", async () => {
    await connect();
    const nf = await call("get_apple_doc", { url: `${A}/documentation/swiftui/does-not-exist` });
    expect(nf.isError).toBe(true);
    expect(nf.text).toMatch(/404|not found/i);
    online = false;
    const net = await call("get_apple_doc", { url: `${A}/documentation/swiftui/navigationstack` });
    expect(net.isError).toBe(true);
    expect(net.text).toMatch(/could not be reached/i);
  });

  it("works without an index", async () => {
    await connect(false);
    const r = await call("get_apple_doc", { url: `${A}/documentation/swiftui/navigationstack` });
    expect(r.isError).toBe(false);
  });
});

describe("get_apple_api_details", () => {
  it("returns exact declaration, kind, availability, parent and URL for a unique symbol", async () => {
    await connect();
    const r = await call("get_apple_api_details", { symbol: "Int.+(_:_:)" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("static func + (lhs: Int, rhs: Int) -> Int");
    expect(r.text).toContain("Symbol kind: Operator");
    expect(r.text).toContain(`${A}/documentation/swift/int/+(_:_:)`);
    expect(r.text).toContain("- `lhs`: The first value to add.");
    expect(r.text).toMatch(/Parent: .*\/documentation\/swift\/int/);
    expect(r.text).toContain("## Availability");
  });

  it("lists candidates instead of guessing when a name is ambiguous", async () => {
    await connect();
    const r = await call("get_apple_api_details", { symbol: "frame" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/2 symbols match/);
    expect(r.text).toContain("frame(width:height:alignment:)");
    expect(r.text).toMatch(/narrow/i);
    expect(calls).toHaveLength(0); // never fetched one of them on a guess
  });

  it("resolves with a full signature or parent qualifier", async () => {
    await connect();
    const r = await call("get_apple_api_details", { symbol: "SwiftUI.NavigationStack" });
    expect(r.text).toContain("nonisolated struct NavigationStack<Data, Root> where Root : View");
  });

  it("says when nothing matches and suggests search results", async () => {
    await connect();
    const r = await call("get_apple_api_details", { symbol: "NavigationStak" });
    expect(r.text).toMatch(/No API symbol/);
    expect(r.text).toMatch(/search_apple_docs/);
  });
});

describe("get_apple_docs_status", () => {
  it("reports sources, counts and gaps", async () => {
    await connect();
    const r = await call("get_apple_docs_status");
    expect(r.text).toContain("Pages indexed: 6");
    expect(r.text).toContain("Known gaps");
    expect(r.text).toContain("Last build: 2026-11-09");
  });

  it("includes recent tool errors", async () => {
    await connect();
    await call("get_apple_doc", { url: `${A}/documentation/swiftui/does-not-exist` });
    expect((await call("get_apple_docs_status")).text).toMatch(/Recent errors[\s\S]*not_found/);
  });

  it("works without an index and says how to build one", async () => {
    await connect(false);
    expect((await call("get_apple_docs_status")).text).toMatch(/Index: not available[\s\S]*index build/);
  });
});
