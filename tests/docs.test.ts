import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppleClient, AppleHttpError, type FetchLike } from "../src/apple/client.ts";
import { DocService } from "../src/apple/docs.ts";
import { DocCache } from "../src/cache/cache.ts";
import { UrlRejected } from "../src/security/url.ts";

const A = "https://developer.apple.com";
const PAGE = `${A}/documentation/storekit/skproductdiscount/type-swift.enum/introductory`;
const DATA = `${A}/tutorials/data/documentation/storekit/skproductdiscount/type-swift.enum/introductory.json`;
const BODY = readFileSync(new URL("./fixtures/enumCase.json", import.meta.url), "utf8");
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let t: number;
let calls: { url: string; headers: Record<string, string> }[];
let respond: (url: string) => Response | Promise<Response>;

const fetch: FetchLike = async (url, init) => {
  calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)) });
  return respond(url);
};
const ok = (body = BODY, etag = '"v1"') => new Response(body, { status: 200, headers: { "content-type": "application/json", etag } });

function service() {
  const now = () => t;
  const client = new AppleClient({ fetch, now, sleep: async () => {}, minIntervalMs: 0 });
  return new DocService({ client, cache: new DocCache({ dir, now }), now });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdm-docs-"));
  t = Date.UTC(2026, 10, 9, 12, 0, 0);
  calls = [];
  respond = () => ok();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

describe("DocService.getDoc", () => {
  it("fetches the DocC JSON on a miss, parses it and caches it", async () => {
    const r = await service().getDoc(PAGE);
    expect(calls.map((c) => c.url)).toEqual([DATA]);
    expect(r.fromCache).toBe(false);
    expect(r.fetchedAt).toBe(t);
    expect(r.page.title).toBe("SKProductDiscount.Type.introductory");
    expect(r.page.url).toBe(PAGE);
    expect(r.markdown.startsWith("# SKProductDiscount.Type.introductory")).toBe(true);
    expect(r.markdown).toContain("(not cached)");
  });

  it("serves a fresh cache hit without any request", async () => {
    await service().getDoc(PAGE);
    t += DAY;
    const r = await service().getDoc(PAGE);
    expect(calls).toHaveLength(1);
    expect(r.fromCache).toBe(true);
    expect(r.fetchedAt).toBe(t - DAY);
    expect(r.markdown).toContain("(from local cache)");
  });

  it("revalidates a stale entry with its ETag and keeps the body on 304", async () => {
    await service().getDoc(PAGE);
    t += 8 * DAY;
    respond = () => new Response(null, { status: 304, headers: { etag: '"v1"' } });
    const r = await service().getDoc(PAGE);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers["if-none-match"]).toBe('"v1"');
    expect(r.fromCache).toBe(true);
    expect(r.revalidated).toBe(true);
    expect(r.fetchedAt).toBe(t);
    expect(r.page.title).toBe("SKProductDiscount.Type.introductory");
    // fresh again: no third request
    await service().getDoc(PAGE);
    expect(calls).toHaveLength(2);
  });

  it("keeps the stored ETag when a 304 response carries no validators", async () => {
    await service().getDoc(PAGE);
    t += 8 * DAY;
    respond = () => new Response(null, { status: 304 });
    await service().getDoc(PAGE);
    t += 8 * DAY;
    await service().getDoc(PAGE);
    expect(calls).toHaveLength(3);
    expect(calls[2].headers["if-none-match"]).toBe('"v1"');
  });

  it("replaces a stale entry when Apple returns new content", async () => {
    await service().getDoc(PAGE);
    t += 8 * DAY;
    const changed = JSON.parse(BODY);
    changed.metadata.title = "Changed title";
    respond = () => ok(JSON.stringify(changed), '"v2"');
    const r = await service().getDoc(PAGE);
    expect(r.fromCache).toBe(false);
    expect(r.page.title).toBe("Changed title");
    expect((await service().getDoc(PAGE)).page.title).toBe("Changed title");
  });

  it("serves a stale copy with an explicit warning when Apple is unreachable", async () => {
    await service().getDoc(PAGE);
    t += 8 * DAY;
    respond = () => Promise.reject(new TypeError("fetch failed"));
    const r = await service().getDoc(PAGE);
    expect(r.fromCache).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.warning).toMatch(/Apple could not be reached/);
    expect(r.markdown.startsWith("> **Warning:** Apple could not be reached")).toBe(true);
    expect(r.markdown).toContain("2026-11-09T12:00:00.000Z"); // the date of the cached copy
  });

  it("throws when Apple is unreachable and nothing is cached", async () => {
    respond = () => Promise.reject(new TypeError("fetch failed"));
    const e = await rejection(service().getDoc(PAGE));
    expect(e).toBeInstanceOf(AppleHttpError);
    expect((e as AppleHttpError).kind).toBe("network");
  });

  it("does not fall back to the cache when the page is gone (404)", async () => {
    await service().getDoc(PAGE);
    t += 8 * DAY;
    respond = () => new Response("<html>", { status: 404, headers: { "content-type": "text/html" } });
    const e = await rejection(service().getDoc(PAGE));
    expect((e as AppleHttpError).kind).toBe("not_found");
  });

  it("rejects an invalid URL before any request", async () => {
    expect(await rejection(service().getDoc("https://evil.com/documentation/x"))).toBeInstanceOf(UrlRejected);
    expect(await rejection(service().getDoc(`${A}/search/?q=x`))).toBeInstanceOf(UrlRejected);
    expect(calls).toHaveLength(0);
  });

  it("renders Objective-C from ?language=objc or the option, sharing one cache entry", async () => {
    const s = service();
    const occ = await s.getDoc(`${PAGE}?language=objc`);
    expect(occ.page.language).toBe("occ");
    expect(occ.page.title).toBe("SKProductDiscountTypeIntroductory");
    const swift = await s.getDoc(PAGE);
    expect(swift.page.language).toBe("swift");
    expect((await s.getDoc(PAGE, { language: "occ" })).page.language).toBe("occ");
    expect(calls).toHaveLength(1);
  });

  it("refetches when the cached body is not a valid page", async () => {
    await service().getDoc(PAGE);
    const pages = join(dir, "pages");
    const file = join(pages, readdirSync(pages)[0]);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...entry, body: "{broken" }));
    const r = await service().getDoc(PAGE);
    expect(calls).toHaveLength(2);
    expect(r.fromCache).toBe(false);
  });

  it("reports the final page URL after an allowed redirect", async () => {
    const moved = `${A}/tutorials/data/documentation/storekit/moved-page.json`;
    respond = (url) => (url === DATA ? new Response(null, { status: 301, headers: { location: moved } }) : ok());
    const r = await service().getDoc(PAGE);
    expect(r.page.url).toBe(`${A}/documentation/storekit/moved-page`);
    expect(r.redirectedFrom).toBe(PAGE);
  });

  it("throws bad_response when Apple returns JSON that is not a page", async () => {
    respond = () => ok('{"unexpected":true}');
    const e = await rejection(service().getDoc(PAGE));
    expect((e as AppleHttpError).kind).toBe("bad_response");
    expect(readdirSync(join(dir, "pages"))).toHaveLength(0); // a non-page response is never cached
  });

  it("loadJson returns the raw page JSON through the same cache", async () => {
    const s = service();
    const a = await s.loadJson(PAGE);
    expect((a.json as any).metadata.title).toBe("SKProductDiscount.Type.introductory");
    expect(a.fromCache).toBe(false);
    expect(a.url).toBe(PAGE);
    const b = await s.loadJson(PAGE);
    expect(b.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("passes maxRelated and includeRelated through to the renderer", async () => {
    const r = await service().getDoc(PAGE, { includeRelated: false });
    expect(r.markdown).not.toContain("## See Also");
  });
});
