import { describe, expect, it } from "vitest";
import { AppleClient, AppleHttpError, type FetchLike, type FetchResult } from "../src/apple/client.ts";

const DATA = "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json";
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

type Call = { url: string; headers: Record<string, string>; redirect?: RequestRedirect };
function fakeFetch(handler: (url: string, call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect };
    calls.push(call);
    return handler(url, call);
  };
  return { fetch, calls };
}
// No real waiting: pacing is checked through the recorded sleeps.
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  // Like a real sleep, time only moves forward once the sleep resolves (not when it is scheduled).
  const sleep = (ms: number) => {
    sleeps.push(ms);
    const until = t + ms;
    return Promise.resolve().then(() => void (t = Math.max(t, until)));
  };
  return { now: () => t, sleep, sleeps, advance: (ms: number) => (t += ms) };
}
function client(fetch: FetchLike, extra: Partial<ConstructorParameters<typeof AppleClient>[0]> = {}) {
  const c = fakeClock();
  return { c, client: new AppleClient({ fetch, now: c.now, sleep: c.sleep, ...extra }) };
}
function ok(r: FetchResult) {
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  return r;
}
async function errorOf(p: Promise<unknown>): Promise<AppleHttpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppleHttpError);
    return e as AppleHttpError;
  }
  throw new Error("expected rejection");
}

describe("AppleClient: success and validation", () => {
  it("returns parsed JSON, raw body and validators", async () => {
    const { fetch, calls } = fakeFetch(() => json({ a: 1 }, { headers: { "content-type": "application/json", etag: '"e1"', "last-modified": "Mon, 26 Oct 2026 05:40:44 GMT" } }));
    const r = await client(fetch).client.getJson(DATA);
    expect(r).toMatchObject({ status: 200, url: DATA, data: { a: 1 }, body: '{"a":1}', etag: '"e1"', lastModified: "Mon, 26 Oct 2026 05:40:44 GMT" });
    expect(calls[0].headers["user-agent"]).toMatch(/swift-docs-mcp/);
    expect(calls[0].redirect).toBe("manual");
  });

  it("accepts a missing content-type (navigator indexes send none)", async () => {
    const { fetch } = fakeFetch(() => {
      const r = new Response('{"x":true}', { status: 200 });
      r.headers.delete("content-type"); // Response adds text/plain for string bodies by default
      return r;
    });
    expect(ok(await client(fetch).client.getJson(DATA)).data).toEqual({ x: true });
  });

  it("rejects an HTML body served with 200", async () => {
    const { fetch } = fakeFetch(() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await errorOf(client(fetch).client.getJson(DATA))).kind).toBe("bad_response");
  });

  it("rejects malformed JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
    expect((await errorOf(client(fetch).client.getJson(DATA))).kind).toBe("bad_response");
  });

  it("refuses to fetch a disallowed URL without calling fetch", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    expect((await errorOf(client(fetch).client.getJson("https://developer.apple.com/search/?q=x"))).kind).toBe("blocked");
    expect((await errorOf(client(fetch).client.getJson("https://evil.com/tutorials/data/x.json"))).kind).toBe("blocked");
    expect(calls).toHaveLength(0);
  });
});

describe("AppleClient: status handling", () => {
  it("maps 404 (Apple's HTML error page) to not_found", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } }));
    const e = await errorOf(client(fetch).client.getJson(DATA));
    expect(e.kind).toBe("not_found");
    expect(e.status).toBe(404);
  });

  it("maps other errors to http with the status, never success", async () => {
    for (const status of [429, 500, 503]) {
      const { fetch } = fakeFetch(() => new Response("", { status }));
      const e = await errorOf(client(fetch).client.getJson(DATA));
      expect([e.kind, e.status]).toEqual(["http", status]);
    }
  });

  it("sends conditional headers and returns 304 without a body", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 304, headers: { etag: '"e1"' } }));
    const r = await client(fetch).client.getJson(DATA, { etag: '"e1"', lastModified: "Mon, 26 Oct 2026 05:40:44 GMT" });
    expect(r).toEqual({ status: 304, url: DATA, etag: '"e1"' });
    expect(calls[0].headers["if-none-match"]).toBe('"e1"');
    expect(calls[0].headers["if-modified-since"]).toBe("Mon, 26 Oct 2026 05:40:44 GMT");
  });

  it("treats a 304 to an unconditional request as a bad response", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 304 }));
    expect((await errorOf(client(fetch).client.getJson(DATA))).kind).toBe("bad_response");
  });

  it("wraps network failures", async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect((await errorOf(client(fetch).client.getJson(DATA))).kind).toBe("network");
  });
});

describe("AppleClient: redirects", () => {
  const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });

  it("follows an allowed redirect and reports the final URL", async () => {
    const target = "https://developer.apple.com/tutorials/data/documentation/swiftui/newview.json";
    const { fetch, calls } = fakeFetch((url) => (url === DATA ? redirect("/tutorials/data/documentation/swiftui/newview.json") : json({ ok: 1 })));
    const r = await client(fetch).client.getJson(DATA);
    expect(r.url).toBe(target);
    expect(calls.map((c) => c.url)).toEqual([DATA, target]);
  });

  it.each([
    ["other host", "https://evil.com/tutorials/data/x.json"],
    ["protocol-relative other host", "//evil.com/tutorials/data/x.json"],
    ["http downgrade", "http://developer.apple.com/tutorials/data/x.json"],
    ["outside data prefix", "/search/?q=x"],
    ["traversal", "/tutorials/data/../../search/x"],
  ])("blocks a redirect to %s without following it", async (_n, location) => {
    const { fetch, calls } = fakeFetch(() => redirect(location));
    expect((await errorOf(client(fetch).client.getJson(DATA))).kind).toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("stops after too many redirects", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => redirect(`/tutorials/data/r${n++}.json`));
    expect((await errorOf(client(fetch, { maxRedirects: 3 }).client.getJson(DATA))).kind).toBe("bad_response");
    expect(calls).toHaveLength(4);
  });

  it("rejects a redirect with no location", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 302 }));
    expect((await errorOf(client(fetch).client.getJson(DATA))).kind).toBe("bad_response");
  });
});

describe("AppleClient: limits", () => {
  it("rejects early when content-length exceeds the cap", async () => {
    const { fetch } = fakeFetch(() => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "999999" } }));
    expect((await errorOf(client(fetch, { maxBytes: 1000 }).client.getJson(DATA))).kind).toBe("too_large");
  });

  it("enforces the cap while streaming (no or lying content-length)", async () => {
    const chunk = new TextEncoder().encode("x".repeat(400));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        if (pulled > 100) ctrl.close();
        else ctrl.enqueue(chunk);
      },
    });
    const { fetch } = fakeFetch(() => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    expect((await errorOf(client(fetch, { maxBytes: 1000 }).client.getJson(DATA))).kind).toBe("too_large");
    expect(pulled).toBeLessThan(10); // stopped reading, did not buffer everything
  });

  it("times out a hanging request", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
    expect((await errorOf(client(fetch, { timeoutMs: 30 }).client.getJson(DATA))).kind).toBe("timeout");
  });
});

describe("AppleClient: pacing and deduplication", () => {
  it("spaces sequential requests by the minimum interval", async () => {
    const { fetch } = fakeFetch(() => json({}));
    const { c, client: cl } = client(fetch, { minIntervalMs: 1000 });
    await cl.getJson(DATA);
    await cl.getJson(DATA.replace("view", "text"));
    await cl.getJson(DATA.replace("view", "list"));
    expect(c.sleeps).toEqual([1000, 1000]);
  });

  it("does not wait when enough time has already passed", async () => {
    const { fetch } = fakeFetch(() => json({}));
    const { c, client: cl } = client(fetch, { minIntervalMs: 1000 });
    await cl.getJson(DATA);
    c.advance(5000);
    await cl.getJson(DATA.replace("view", "text"));
    expect(c.sleeps).toEqual([]);
  });

  it("spaces concurrent requests too", async () => {
    const { fetch } = fakeFetch(() => json({}));
    const { c, client: cl } = client(fetch, { minIntervalMs: 1000 });
    await Promise.all(["a", "b", "c"].map((s) => cl.getJson(DATA.replace("view", s))));
    expect(c.sleeps).toEqual([1000, 2000]);
  });

  it("shares one request between identical concurrent calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fetch, calls } = fakeFetch(async () => {
      await gate;
      return json({ v: 1 });
    });
    const { client: cl } = client(fetch);
    const p1 = cl.getJson(DATA);
    const p2 = cl.getJson(DATA);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toHaveLength(1);
    expect(ok(r1).data).toEqual(ok(r2).data);
    await cl.getJson(DATA); // settled -> a later call fetches again
    expect(calls).toHaveLength(2);
  });
});
