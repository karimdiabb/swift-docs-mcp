// Polite, locked-down HTTP client for Apple's DocC JSON endpoints.
// - every URL (including each redirect hop) must pass assertFetchable
// - requests are paced (minimum interval between request starts), identical in-flight calls are shared
// - timeout covers headers and body; size cap is enforced while streaming (decompressed bytes)
// - failures are typed errors; nothing is ever turned into an empty "success"
import { assertFetchable, UrlRejected } from "../security/url.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  fetch?: FetchLike;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type Validators = { etag?: string; lastModified?: string };

export type FetchResult =
  | ({ status: 200; url: string; data: unknown; body: string } & Validators)
  | ({ status: 304; url: string } & Validators);

export type HttpErrorKind = "not_found" | "blocked" | "too_large" | "timeout" | "bad_response" | "network" | "http";

export class AppleHttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly url: string;
  readonly status?: number;
  constructor(kind: HttpErrorKind, url: string, message: string, status?: number) {
    super(`${kind}: ${message} (${url})`);
    this.name = "AppleHttpError";
    this.kind = kind;
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const USER_AGENT = "swift-docs-mcp/0.1 (local read-only documentation reader)";

export class AppleClient {
  private readonly fetch: FetchLike;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextStart = 0;
  private readonly inFlight = new Map<string, Promise<FetchResult>>();

  constructor(o: ClientOptions = {}) {
    this.fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.minIntervalMs = o.minIntervalMs ?? 1000;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.maxBytes = o.maxBytes ?? 25 * 1024 * 1024; // largest navigator index seen: 10.8 MB
    this.maxRedirects = o.maxRedirects ?? 3;
    this.userAgent = o.userAgent ?? USER_AGENT;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  getJson(target: string, validators: Validators = {}): Promise<FetchResult> {
    let url: URL;
    try {
      url = assertFetchable(target);
    } catch (e) {
      return Promise.reject(new AppleHttpError("blocked", String(target), (e as Error).message));
    }
    const key = `${url.href}\n${validators.etag ?? ""}\n${validators.lastModified ?? ""}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = this.run(url, validators).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async run(start: URL, validators: Validators): Promise<FetchResult> {
    let url = start;
    for (let hop = 0; ; hop++) {
      await this.pace();
      const signal = AbortSignal.timeout(this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetch(url.href, { redirect: "manual", signal, headers: this.headers(validators) });
      } catch (e) {
        throw this.wrap(e, url.href);
      }

      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        if (hop >= this.maxRedirects) throw new AppleHttpError("bad_response", url.href, "too many redirects", res.status);
        const location = res.headers.get("location");
        if (!location) throw new AppleHttpError("bad_response", url.href, "redirect without location", res.status);
        try {
          url = assertFetchable(location, url);
        } catch (e) {
          throw new AppleHttpError("blocked", url.href, `redirect refused: ${(e as UrlRejected).message}`, res.status);
        }
        continue;
      }

      const v = pickValidators(res.headers);
      if (res.status === 304) {
        await res.body?.cancel().catch(() => {});
        if (!validators.etag && !validators.lastModified) throw new AppleHttpError("bad_response", url.href, "304 for an unconditional request", 304);
        return { status: 304, url: url.href, ...v };
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {});
        throw new AppleHttpError("not_found", url.href, "page not found", res.status);
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        throw new AppleHttpError("http", url.href, `unexpected status ${res.status}`, res.status);
      }

      const type = res.headers.get("content-type");
      if (type && !/^application\/(.+\+)?json\b/i.test(type)) {
        await res.body?.cancel().catch(() => {});
        throw new AppleHttpError("bad_response", url.href, `not JSON: ${type}`, 200);
      }
      const body = await this.readCapped(res, url.href);
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        throw new AppleHttpError("bad_response", url.href, "malformed JSON", 200);
      }
      return { status: 200, url: url.href, data, body, ...v };
    }
  }

  // Reserve the next start slot synchronously, then wait for it. Works for concurrent callers too.
  private async pace() {
    const now = this.now();
    const start = Math.max(now, this.nextStart);
    this.nextStart = start + this.minIntervalMs;
    if (start > now) await this.sleep(start - now);
  }

  private headers(v: Validators): Record<string, string> {
    const h: Record<string, string> = { "user-agent": this.userAgent, accept: "application/json" };
    if (v.etag) h["if-none-match"] = v.etag;
    if (v.lastModified) h["if-modified-since"] = v.lastModified;
    return h;
  }

  private async readCapped(res: Response, url: string): Promise<string> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new AppleHttpError("too_large", url, `content-length ${declared} > ${this.maxBytes}`, 200);
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new AppleHttpError("too_large", url, `body over ${this.maxBytes} bytes`, 200);
        }
        chunks.push(value);
      }
    } catch (e) {
      throw this.wrap(e, url);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  private wrap(e: unknown, url: string): AppleHttpError {
    if (e instanceof AppleHttpError) return e;
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") return new AppleHttpError("timeout", url, `no response within ${this.timeoutMs} ms`);
    return new AppleHttpError("network", url, (e as Error)?.message ?? String(e));
  }
}

function pickValidators(h: Headers): Validators {
  const v: Validators = {};
  const etag = h.get("etag");
  const lm = h.get("last-modified");
  if (etag) v.etag = etag;
  if (lm) v.lastModified = lm;
  return v;
}
