// Retrieval service: URL validation -> cache -> Apple (conditional when stale) -> parse -> Markdown.
// This is what the MCP tools call. It never reports a stale or failed fetch as a fresh success.
import { AppleClient, AppleHttpError } from "./client.ts";
import { parseRenderNode } from "./docc-parser.ts";
import { renderMarkdown } from "./markdown.ts";
import type { DocPage } from "./types.ts";
import { DocCache, type CacheEntry } from "../cache/cache.ts";
import { parseDocUrl, type DocUrl, type Language } from "../security/url.ts";

const SITE_NAME: Record<string, string> = { "developer.apple.com": "Apple", "docs.swift.org": "docs.swift.org" };

export type GetDocOptions = { language?: Language; maxRelated?: number; includeRelated?: boolean };

export type DocResult = {
  page: DocPage;
  markdown: string;
  /** Content came from the local cache (fresh hit, 304 revalidation, or stale fallback). */
  fromCache: boolean;
  /** When Apple last served or confirmed this content. */
  fetchedAt: number;
  /** A stale entry was confirmed unchanged by Apple (304). */
  revalidated: boolean;
  /** Apple could not be reached; this is an older cached copy. */
  stale?: boolean;
  warning?: string;
  redirectedFrom?: string;
};

export type DocServiceDeps = { client: AppleClient; cache: DocCache; now?: () => number };

// Failures where an older cached copy is still a useful, honest answer. 404 is not one: the page may be gone.
const FALLBACK_KINDS = new Set(["network", "timeout", "http"]);

export class DocService {
  private readonly client: AppleClient;
  private readonly cache: DocCache;
  private readonly now: () => number;

  constructor(d: DocServiceDeps) {
    this.client = d.client;
    this.cache = d.cache;
    this.now = d.now ?? Date.now;
  }

  async getDoc(url: string, opts: GetDocOptions = {}): Promise<DocResult> {
    const u = parseDocUrl(url);
    const language = opts.language ?? u.language;
    const l = await this.load(u);
    const page = parseRenderNode(l.json, { url: l.url, ...(language ? { language } : {}) });
    return this.render(page, l.entry, l.flags, opts);
  }

  /** Raw DocC JSON for a documentation URL, through the same cache/revalidation path as getDoc. */
  async loadJson(url: string): Promise<{ json: unknown; url: string; fetchedAt: number; fromCache: boolean; stale?: boolean; warning?: string }> {
    const l = await this.load(parseDocUrl(url));
    return { json: l.json, url: l.url, fetchedAt: l.entry.fetchedAt, ...l.flags };
  }

  private async load(u: DocUrl): Promise<{ json: unknown; url: string; entry: CacheEntry; flags: Flags }> {
    const hit = this.cache.get(u.key);
    const cachedJson = hit ? asPage(tryParse(hit.entry.body)) : undefined;
    const usable = hit && cachedJson !== undefined ? hit : undefined;

    if (usable && usable.fresh) return { json: cachedJson, url: usable.entry.url || u.humanUrl, entry: usable.entry, flags: { fromCache: true, revalidated: false } };

    let r;
    try {
      r = await this.client.getJson(u.dataUrl, usable ? { etag: usable.entry.etag, lastModified: usable.entry.lastModified } : {});
    } catch (e) {
      if (usable && e instanceof AppleHttpError && FALLBACK_KINDS.has(e.kind)) {
        const warning = `${SITE_NAME[u.host] ?? u.host} could not be reached (${e.kind}${e.status ? ` ${e.status}` : ""}); showing the cached copy from ${new Date(usable.entry.fetchedAt).toISOString()}.`;
        return { json: cachedJson, url: usable.entry.url || u.humanUrl, entry: usable.entry, flags: { fromCache: true, revalidated: false, stale: true, warning } };
      }
      throw e;
    }

    if (r.status === 304) {
      if (!usable) throw new AppleHttpError("bad_response", u.dataUrl, "304 without a cached copy");
      this.cache.touch(u.key, { etag: r.etag, lastModified: r.lastModified });
      return { json: cachedJson, url: usable.entry.url || u.humanUrl, entry: { ...usable.entry, fetchedAt: this.now() }, flags: { fromCache: true, revalidated: true } };
    }

    // Validate before caching, so a non-page response is never stored.
    if (asPage(r.data) === undefined) throw new AppleHttpError("bad_response", r.url, "not a DocC RenderNode");
    const finalHuman = r.url === u.dataUrl ? u.humanUrl : humanFromData(r.url);
    const entry = this.cache.set({ key: u.key, url: finalHuman, body: r.body, ...(r.etag ? { etag: r.etag } : {}), ...(r.lastModified ? { lastModified: r.lastModified } : {}) });
    const flags: Flags = { fromCache: false, revalidated: false, ...(finalHuman !== u.humanUrl ? { redirectedFrom: u.humanUrl } : {}) };
    return { json: r.data, url: finalHuman, entry, flags };
  }

  private render(page: DocPage, entry: CacheEntry, flags: Flags, opts: GetDocOptions): DocResult {
    let markdown = renderMarkdown(page, {
      fetchedAt: entry.fetchedAt,
      fromCache: flags.fromCache,
      ...(opts.maxRelated !== undefined ? { maxRelated: opts.maxRelated } : {}),
      ...(opts.includeRelated !== undefined ? { includeRelated: opts.includeRelated } : {}),
    });
    if (flags.warning) markdown = `> **Warning:** ${flags.warning}\n\n${markdown}`;
    return { page, markdown, fetchedAt: entry.fetchedAt, ...flags };
  }
}

type Flags = { fromCache: boolean; revalidated: boolean; stale?: boolean; warning?: string; redirectedFrom?: string };

function tryParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function asPage(v: unknown): unknown {
  const j = v as any;
  return j && typeof j === "object" && !Array.isArray(j) && j.metadata && typeof j.metadata === "object" && typeof j.identifier?.url === "string" ? v : undefined;
}

/** https://developer.apple.com/tutorials/data/documentation/x.json -> https://developer.apple.com/documentation/x */
function humanFromData(dataUrl: string): string {
  const u = new URL(dataUrl);
  return `${u.origin}${u.pathname.replace(/^\/tutorials\/data/, "").replace(/\.json$/, "")}`;
}
