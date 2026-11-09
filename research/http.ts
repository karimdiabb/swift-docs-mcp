// Polite fetch helper for Phase 1 research probes only (not production code).
// - one request per second, sequential
// - clear User-Agent, timeout, response-size cap
// - refuses robots-disallowed paths and non-Apple hosts
// - manual redirects so we can record them
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ORIGIN = "https://developer.apple.com";
const UA = "swift-docs-mcp-research/0.0 (local read-only documentation indexer)";
const MIN_INTERVAL_MS = 1000;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 20 * 1024 * 1024;
const DISALLOWED = ["/cgi-bin/", "/click/", "/documentation/dataformats/", "/reference/", "/search/", "/survey/", "/temp/", "/unsubscribe/", "/forums/"];

// Raw responses go outside the repo (scratchpad) unless OUT_DIR is set.
export const OUT_DIR = process.env.OUT_DIR ?? "research/out";

let last = 0;
export let requestCount = 0;

export type Probe = {
  url: string;
  status: number;
  contentType: string | null;
  bytes: number;
  ms: number;
  location: string | null;
  headers: Record<string, string>;
  body: string;
};

export async function probe(pathOrUrl: string, extraHeaders: Record<string, string> = {}): Promise<Probe> {
  const url = new URL(pathOrUrl, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error(`refusing non-Apple origin: ${url.origin}`);
  if (DISALLOWED.some((p) => url.pathname.toLowerCase().startsWith(p))) throw new Error(`robots-disallowed: ${url.pathname}`);

  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  requestCount++;

  const t0 = performance.now();
  const res = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": UA, accept: "application/json, text/html;q=0.5", ...extraHeaders },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`response too large: ${buf.length}`);
  return {
    url: url.href,
    status: res.status,
    contentType: res.headers.get("content-type"),
    bytes: buf.length,
    ms: Math.round(performance.now() - t0),
    location: res.headers.get("location"),
    headers: Object.fromEntries(res.headers),
    body: buf.toString("utf8"),
  };
}

export async function json<T = any>(path: string): Promise<{ p: Probe; data: T | null }> {
  const p = await probe(path);
  let data: T | null = null;
  try {
    if (p.status === 200) data = JSON.parse(p.body);
  } catch {}
  return { p, data };
}

export function save(name: string, content: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return file;
}
