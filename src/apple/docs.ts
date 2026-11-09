// Retrieval service: URL validation -> cache -> Apple (conditional when stale) -> parse -> Markdown.
// This is what the MCP tools call. It never reports a stale or failed fetch as a fresh success.
import { AppleClient, AppleHttpError } from "./client.ts";
import { parseRenderNode } from "./docc-parser.ts";
import { renderMarkdown } from "./markdown.ts";
import type { DocPage } from "./types.ts";
import { DocCache, type CacheEntry } from "../cache/cache.ts";
import { parseDocUrl, type Language } from "../security/url.ts";

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
    const hit = this.cache.get(u.key);
    const cachedJson = hit ? tryParse(hit.entry.body) : undefined;
    const usable = hit && cachedJson !== undefined ? hit : undefined;

    if (usable?.fresh) return this.finish(cachedJson, usable.entry, u.humanUrl, { fromCache: true, revalidated: false }, language, opts);

    let r;
    try {
      r = await this.client.getJson(u.dataUrl, usable ? { etag: usable.entry.etag, lastModified: usable.entry.lastModified } : {});
    } catch (e) {
      if (usable && e instanceof AppleHttpError && FALLBACK_KINDS.has(e.kind)) {
        const warning = `Apple could not be reached (${e.kind}${e.status ? ` ${e.status}` : ""}); showing the cached copy from ${new Date(usable.entry.fetchedAt).toISOString()}.`;
        return this.finish(cachedJson, usable.entry, u.humanUrl, { fromCache: true, revalidated: false, stale: true, warning }, language, opts);
      }
      throw e;
    }

    if (r.status === 304) {
      if (!usable) throw new AppleHttpError("bad_response", u.dataUrl, "304 without a cached copy");
      this.cache.touch(u.key, { etag: r.etag, lastModified: r.lastModified });
      const entry = { ...usable.entry, fetchedAt: this.now() };
      return this.finish(cachedJson, entry, u.humanUrl, { fromCache: true, revalidated: true }, language, opts);
    }

    const finalHuman = r.url === u.dataUrl ? u.humanUrl : humanFromData(r.url);
    // Parse before caching, so a non-page response is never stored.
    const page = parseRenderNode(r.data, { url: finalHuman, ...(language ? { language } : {}) });
    const entry = this.cache.set({ key: u.key, url: finalHuman, body: r.body, ...(r.etag ? { etag: r.etag } : {}), ...(r.lastModified ? { lastModified: r.lastModified } : {}) });
    const extra = finalHuman !== u.humanUrl ? { redirectedFrom: u.humanUrl } : {};
    return this.render(page, entry, { fromCache: false, revalidated: false, ...extra }, opts);
  }

  private finish(json: unknown, entry: CacheEntry, humanUrl: string, flags: Flags, language: Language | undefined, opts: GetDocOptions): DocResult {
    const page = parseRenderNode(json, { url: entry.url || humanUrl, ...(language ? { language } : {}) });
    return this.render(page, entry, flags, opts);
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
    const v = JSON.parse(body);
    return v && typeof v === "object" && v.metadata && v.identifier ? v : undefined;
  } catch {
    return undefined;
  }
}

/** https://developer.apple.com/tutorials/data/documentation/x.json -> https://developer.apple.com/documentation/x */
function humanFromData(dataUrl: string): string {
  const u = new URL(dataUrl);
  return `${u.origin}${u.pathname.replace(/^\/tutorials\/data/, "").replace(/\.json$/, "")}`;
}
