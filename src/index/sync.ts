// Index build / refresh / enrich.
//
// Discovery (see README section 4):
// 1. technologies.json lists ~400 roots (frameworks, collections, HIG).
// 2. Each root's navigator index (/tutorials/data/index/<slug>) lists its pages. Conditional GET: 304 = unchanged.
// 3. Roots without an index (404: HIG, a few nested collections) and tutorial roots are walked via page links.
// Safety: a failed fetch never deletes pages; an index that would remove more than half a root is refused.
import { AppleClient, AppleHttpError } from "../apple/client.ts";
import { parseRenderNode } from "../apple/docc-parser.ts";
import { DocService } from "../apple/docs.ts";
import type { DocPage } from "../apple/types.ts";
import { urlForPath } from "../security/url.ts";
import { parseNavigator, parseSwiftOrgCollections, type NavEntry } from "./navigator.ts";
import { IndexStore, type Enrichment, type RootRow } from "./store.ts";

const ORIGIN = "https://developer.apple.com";
const TECHNOLOGIES = `${ORIGIN}/tutorials/data/documentation/technologies.json`;
const SWIFT_ORG_INDEX = "https://docs.swift.org/latest/index/index.json";
const SWIFT_ORG = "swift.org";
const MAX_REMOVAL_RATIO = 0.5;
const MIN_PAGES_FOR_RATIO_CHECK = 20;

export type SyncOptions = {
  mode: "build" | "refresh";
  /** Only these root slugs (e.g. ["swiftui"]). Skips root-list changes and tutorial discovery. */
  only?: string[];
  /** Max pages per walked root (default 3000). */
  maxWalkPages?: number;
  /** Tutorial roots to walk even if no page links to them, e.g. ["/tutorials/swiftui"]. */
  tutorialSeeds?: string[];
  /** Also index docs.swift.org collections (the Swift book, ...) that Apple's catalog doesn't already have. */
  swiftOrg?: boolean;
};

export type RootReport = { path: string; status: RootRow["status"]; method: RootRow["method"]; docs: number; changed: boolean; removed: number; error?: string };
export type SyncReport = { mode: SyncOptions["mode"]; startedAt: number; finishedAt: number; roots: RootReport[]; removed: number; docs: number; errors: string[]; partial: boolean };
export type EnrichReport = { enriched: number; failed: number; notFound: number; aborted: boolean; errors: string[] };

export type IndexerDeps = { client: AppleClient; docs: DocService; store: IndexStore; now?: () => number; log?: (msg: string) => void };

type RootInfo = { path: string; slug: string; title: string; role: string };

export class Indexer {
  private readonly client: AppleClient;
  private readonly docs: DocService;
  private readonly store: IndexStore;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private progress = "";

  constructor(d: IndexerDeps) {
    this.client = d.client;
    this.docs = d.docs;
    this.store = d.store;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => process.stderr.write(m + "\n"));
  }

  async sync(o: SyncOptions): Promise<SyncReport> {
    const startedAt = this.now();
    this.store.setMeta("syncState", "running");
    this.store.setMeta("syncStartedAt", String(startedAt));
    this.log(`index ${o.mode}: starting`);
    const errors: string[] = [];
    const reports: RootReport[] = [];
    const only = o.only?.map((s) => s.toLowerCase());

    // 1. root list
    const listed = await this.technologies(o.mode, errors);
    for (const r of listed) {
      const existing = this.store.getRoot(r.path);
      if (!existing) this.store.upsertRoot({ path: r.path, slug: r.slug, title: r.title, role: r.role, method: "navigator", status: "pending" });
      else if (existing.status === "removed") this.store.upsertRoot({ ...existing, title: r.title, role: r.role, status: "pending" });
      else if (existing.title !== r.title) this.store.upsertRoot({ ...existing, title: r.title });
    }
    if (!only && listed.length) {
      const listedPaths = new Set(listed.map((r) => r.path));
      for (const r of this.store.listRoots()) {
        if (r.role !== "tutorials" && r.role !== SWIFT_ORG && r.status !== "removed" && !listedPaths.has(r.path)) {
          const n = this.store.markRootRemoved(r.path, this.now());
          this.store.upsertRoot({ ...r, status: "removed", docCount: 0, checkedAt: this.now() });
          reports.push({ path: r.path, status: "removed", method: r.method, docs: 0, changed: true, removed: n });
          this.log(`  ${r.path}: no longer listed by Apple, ${n} pages marked removed`);
        }
      }
    }
    if (!only) for (const seed of o.tutorialSeeds ?? []) this.addTutorialRoot(seed);

    // 2. each root (tutorial roots last: walks can discover more of them)
    const done = new Set<string>();
    for (;;) {
      const next = this.store
        .listRoots()
        .filter((r) => r.role !== SWIFT_ORG && r.status !== "removed" && !done.has(r.path) && (!only || only.includes(r.slug)))
        .sort((a, b) => Number(a.role === "tutorials") - Number(b.role === "tutorials"))[0];
      if (!next) break;
      done.add(next.path);
      const remaining = this.store.listRoots().filter((r) => r.role !== SWIFT_ORG && r.status !== "removed" && !done.has(r.path) && (!only || only.includes(r.slug))).length;
      this.progress = `[${done.size}/${done.size + remaining}] `;
      const rep = await this.syncRoot(next, o);
      reports.push(rep);
      if (rep.error) errors.push(`${rep.path}: ${rep.error}`);
    }

    this.progress = "";
    if (o.swiftOrg && (!only || only.includes(SWIFT_ORG))) {
      this.log(`  ${SWIFT_ORG}: fetching the docs.swift.org index`);
      const rep = await this.syncSwiftOrg(o.mode, errors);
      reports.push(...rep);
    }

    const finishedAt = this.now();
    const report: SyncReport = {
      mode: o.mode,
      startedAt,
      finishedAt,
      roots: reports,
      removed: reports.reduce((s, r) => s + r.removed, 0),
      docs: this.store.stats().docs,
      errors,
      partial: reports.some((r) => r.status === "partial" || r.status === "error") || errors.length > 0,
    };
    this.store.setMeta(o.mode === "build" ? "lastBuild" : "lastRefresh", String(finishedAt));
    this.store.setMeta("lastSync", JSON.stringify({ mode: o.mode, startedAt, finishedAt, removed: report.removed, partial: report.partial, errors: errors.slice(0, 50) }));
    this.store.setMeta("syncState", report.partial ? "partial" : "complete");
    this.log(`index ${o.mode}: done, ${report.docs} pages, ${report.removed} removed, ${errors.length} errors`);
    return report;
  }

  /** Fetch the page JSON for pending pages of the given navigator kinds and store abstract/platforms/declaration. */
  async enrich(o: { kinds: string[]; framework?: string; max: number }): Promise<EnrichReport> {
    const paths = this.store.pendingEnrichment({ kinds: o.kinds, limit: o.max, ...(o.framework ? { framework: o.framework } : {}) });
    const rep: EnrichReport = { enriched: 0, failed: 0, notFound: 0, aborted: false, errors: [] };
    let consecutiveNetwork = 0;
    this.log(`enrich: ${paths.length} pages`);
    for (const [i, path] of paths.entries()) {
      try {
        const r = await this.docs.getDoc(urlForPath(path), { includeRelated: false });
        this.store.enrich(path, enrichmentOf(r.page), this.now());
        rep.enriched++;
        consecutiveNetwork = 0;
      } catch (e) {
        rep.failed++;
        const kind = e instanceof AppleHttpError ? e.kind : "error";
        if (kind === "not_found") {
          rep.notFound++;
          this.store.enrich(path, {}, this.now()); // don't retry a page Apple no longer serves
        } else if (rep.errors.length < 50) rep.errors.push(`${path}: ${(e as Error).message}`);
        consecutiveNetwork = kind === "network" || kind === "timeout" ? consecutiveNetwork + 1 : 0;
        if (consecutiveNetwork >= 5) {
          rep.aborted = true;
          rep.errors.push("aborted after 5 consecutive network errors");
          break;
        }
      }
      if ((i + 1) % 100 === 0) this.log(`enrich: ${i + 1}/${paths.length}`);
    }
    this.store.setMeta("lastEnrich", JSON.stringify({ at: this.now(), ...rep, errors: rep.errors.slice(0, 20) }));
    return rep;
  }

  // ---------- roots ----------

  private async technologies(mode: SyncOptions["mode"], errors: string[]): Promise<RootInfo[]> {
    const stored = this.store.getMeta("technologiesRoots");
    const validators = mode === "refresh" && stored ? { etag: this.store.getMeta("technologiesEtag"), lastModified: this.store.getMeta("technologiesLastModified") } : {};
    try {
      const r = await this.client.getJson(TECHNOLOGIES, clean(validators));
      if (r.status === 304 && stored) return JSON.parse(stored);
      if (r.status !== 200) throw new Error("unexpected 304");
      const roots = rootsFromTechnologies(r.data);
      if (!roots.length) throw new Error("technologies.json lists no roots");
      this.store.setMeta("technologiesRoots", JSON.stringify(roots));
      if (r.etag) this.store.setMeta("technologiesEtag", r.etag);
      if (r.lastModified) this.store.setMeta("technologiesLastModified", r.lastModified);
      return roots;
    } catch (e) {
      const msg = `technologies.json: ${(e as Error).message}`;
      if (mode === "refresh" && stored) {
        errors.push(msg);
        this.log(`  ${msg} (using the stored root list)`);
        return [];
      }
      throw new Error(msg);
    }
  }

  private addTutorialRoot(path: string) {
    const p = normalizePath(path);
    if (!p || !/^\/tutorials\/[a-z0-9-]+$/.test(p) || p === "/tutorials/data") return;
    if (this.store.getRoot(p)) return;
    this.store.upsertRoot({ path: p, slug: p.split("/").pop()!, title: p, role: "tutorials", method: "walk", status: "pending" });
  }

  private async syncRoot(root: RootRow, o: SyncOptions): Promise<RootReport> {
    const start = this.now();
    const prevCount = this.store.rootDocCount(root.path);
    const fail = (error: string): RootReport => {
      this.store.upsertRoot({ ...root, status: "error", error, checkedAt: start, docCount: prevCount });
      this.log(`  ${this.progress}${root.path}: ${error}`);
      return { path: root.path, status: "error", method: root.method, docs: prevCount, changed: false, removed: 0, error };
    };

    let entries: (NavEntry & Enrichment)[];
    let method: RootRow["method"] = "navigator";
    let truncated: string | undefined;
    let validators: { etag?: string; lastModified?: string } = {};

    if (root.role !== "tutorials") {
      const conditional = o.mode === "refresh" && root.method === "navigator" && prevCount > 0 ? clean({ etag: root.etag, lastModified: root.lastModified }) : {};
      try {
        const r = await this.client.getJson(`${ORIGIN}/tutorials/data/index/${encodeURIComponent(root.slug)}`, conditional);
        if (r.status === 304) {
          this.store.touchRoot(root.path, start);
          this.store.upsertRoot({ ...root, method: "navigator", status: "ok", error: undefined, checkedAt: start, docCount: prevCount });
          return { path: root.path, status: "ok", method: "navigator", docs: prevCount, changed: false, removed: 0 };
        }
        entries = parseNavigator(r.data);
        validators = clean({ etag: r.etag, lastModified: r.lastModified });
        if (!entries.length) return fail("navigator index is empty");
      } catch (e) {
        if (!(e instanceof AppleHttpError && e.kind === "not_found")) return fail((e as Error).message);
        method = "walk";
        entries = [];
      }
    } else method = "walk";

    if (method === "walk") {
      try {
        const w = await this.walk(root.path, o.maxWalkPages ?? 3000, !o.only);
        entries = w.entries;
        truncated = w.truncated;
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    return this.apply(root, entries!, start, prevCount, method, validators, truncated);
  }

  /** Store a root's fresh page list; remove what disappeared, unless the walk was cut short or too much would go. */
  private apply(root: RootRow, entries: (NavEntry & Enrichment)[], start: number, prevCount: number, method: RootRow["method"], validators: { etag?: string; lastModified?: string }, truncated?: string): RootReport {
    this.store.upsertEntries(root.path, entries, start, this.now());
    let removed = 0;
    let status: RootRow["status"] = "ok";
    let error: string | undefined;
    const notSeen = this.store.countNotSeen(root.path, start);
    if (truncated) {
      status = "partial";
      error = truncated; // incomplete walk: don't treat unvisited pages as removed
    } else if (prevCount >= MIN_PAGES_FOR_RATIO_CHECK && notSeen > prevCount * MAX_REMOVAL_RATIO) {
      status = "partial";
      error = `refusing to remove ${notSeen} of ${prevCount} pages (more than ${MAX_REMOVAL_RATIO * 100}%); the index may be truncated`;
      this.store.touchRoot(root.path, start);
    } else removed = this.store.markRemovedNotSeen(root.path, start, this.now());

    const docs = this.store.rootDocCount(root.path);
    this.store.upsertRoot({ ...root, method, status, error, checkedAt: start, changedAt: start, docCount: docs, ...validators, ...(method === "walk" ? { etag: undefined, lastModified: undefined } : {}) });
    this.log(`  ${this.progress}${root.path}: ${docs} pages via ${method}${removed ? `, ${removed} removed` : ""}${error ? ` (${error})` : ""}`);
    return { path: root.path, status, method, docs, changed: true, removed, ...(error ? { error } : {}) };
  }

  /**
   * docs.swift.org: one navigator index for all collections. Collections whose slug matches an Apple root
   * (Standard Library, Testing) are skipped, because Apple's copy is the canonical one and already indexed.
   */
  private async syncSwiftOrg(mode: SyncOptions["mode"], errors: string[]): Promise<RootReport[]> {
    const start = this.now();
    const known = this.store.listRoots().filter((r) => r.role === SWIFT_ORG && r.status !== "removed");
    const validators = mode === "refresh" && known.length ? clean({ etag: this.store.getMeta("swiftOrgEtag"), lastModified: this.store.getMeta("swiftOrgLastModified") }) : {};
    let data: unknown;
    let fresh: { etag?: string; lastModified?: string } = {};
    try {
      const r = await this.client.getJson(SWIFT_ORG_INDEX, validators);
      if (r.status === 304) {
        for (const root of known) {
          this.store.touchRoot(root.path, start);
          this.store.upsertRoot({ ...root, status: "ok", error: undefined, checkedAt: start });
        }
        return known.map((r) => ({ path: r.path, status: "ok" as const, method: "navigator" as const, docs: this.store.rootDocCount(r.path), changed: false, removed: 0 }));
      }
      data = r.data;
      fresh = clean({ etag: r.etag, lastModified: r.lastModified });
    } catch (e) {
      const msg = `${SWIFT_ORG}: ${(e as Error).message}`;
      errors.push(msg);
      this.log(`  ${msg}`);
      for (const root of known) this.store.upsertRoot({ ...root, status: "error", error: (e as Error).message, checkedAt: start });
      return [];
    }

    let collections;
    try {
      collections = parseSwiftOrgCollections(data);
    } catch (e) {
      errors.push(`${SWIFT_ORG}: ${(e as Error).message}`);
      return [];
    }
    const appleSlugs = new Set(this.store.listRoots().filter((r) => r.role !== SWIFT_ORG && r.status !== "removed" && r.path.startsWith("/documentation/")).map((r) => r.slug));
    const skipped = collections.filter((c) => appleSlugs.has(c.slug)).map((c) => c.title);
    const reports: RootReport[] = [];
    const listed = new Set<string>();
    for (const c of collections) {
      if (appleSlugs.has(c.slug)) continue;
      listed.add(c.path);
      const root: RootRow = this.store.getRoot(c.path) ?? { path: c.path, slug: c.slug, title: c.title, role: SWIFT_ORG, method: "navigator", status: "pending" };
      reports.push(this.apply({ ...root, title: c.title, role: SWIFT_ORG }, c.entries, start, this.store.rootDocCount(c.path), "navigator", {}));
    }
    for (const r of known) {
      if (listed.has(r.path)) continue;
      const n = this.store.markRootRemoved(r.path, this.now());
      this.store.upsertRoot({ ...r, status: "removed", docCount: 0, checkedAt: start });
      reports.push({ path: r.path, status: "removed", method: r.method, docs: 0, changed: true, removed: n });
    }
    if (fresh.etag) this.store.setMeta("swiftOrgEtag", fresh.etag);
    if (fresh.lastModified) this.store.setMeta("swiftOrgLastModified", fresh.lastModified);
    this.store.setMeta("swiftOrgSkipped", JSON.stringify(skipped));
    if (skipped.length) this.log(`  ${SWIFT_ORG}: skipped ${skipped.join(", ")} (Apple's copy is indexed)`);
    return reports;
  }

  /** Breadth-first walk of pages under `rootPath`, following topic links. Pages come from the doc cache when fresh. */
  private async walk(rootPath: string, max: number, discoverTutorials: boolean): Promise<{ entries: (NavEntry & Enrichment)[]; truncated?: string }> {
    const queue = [rootPath];
    const seen = new Set(queue);
    const entries: (NavEntry & Enrichment)[] = [];
    this.log(`  ${this.progress}walking ${rootPath} (no navigator index; about 1 page per second)`);
    while (queue.length) {
      if (entries.length >= max) return { entries, truncated: `walk limit of ${max} pages reached` };
      const path = queue.shift()!;
      let json: any;
      let url: string;
      try {
        const r = await this.docs.loadJson(urlForPath(path));
        json = r.json;
        url = r.url;
      } catch (e) {
        if (path === rootPath) throw new Error(`root page: ${(e as Error).message}`);
        continue; // a broken child link is not fatal
      }
      const page = parseRenderNode(json, { url });
      entries.push({ ...entryOf(path, page), ...enrichmentOf(page) });
      if (entries.length % 25 === 0) this.log(`    ${rootPath}: ${entries.length} pages walked, ${queue.length} queued`);
      for (const ref of Object.values<any>(json.references ?? {})) {
        if (ref?.type !== "topic" && ref?.type !== "link") continue;
        const p = normalizePath(String(ref.url ?? ""));
        if (!p) continue;
        if (p.startsWith(rootPath + "/") && ref.type === "topic" && !seen.has(p)) {
          seen.add(p);
          queue.push(p);
        } else if (discoverTutorials) this.addTutorialRoot(p);
      }
    }
    return { entries };
  }
}

function rootsFromTechnologies(data: any): RootInfo[] {
  const out = new Map<string, RootInfo>();
  for (const r of Object.values<any>(data?.references ?? {})) {
    if (r?.type !== "topic" || typeof r.url !== "string") continue;
    const path = normalizePath(r.url);
    if (!path || !(path.startsWith("/documentation/") || path.startsWith("/design/"))) continue;
    out.set(path, { path, slug: path.split("/").pop()!, title: String(r.title ?? path), role: String(r.role ?? "collection") });
  }
  return [...out.values()];
}

/** "/documentation/SwiftUI/View/#x" or "https://developer.apple.com/..." -> lowercase path; undefined for other hosts. */
function normalizePath(u: string): string | undefined {
  let s = u.trim();
  if (/^https?:\/\//i.test(s)) {
    if (!/^https:\/\/developer\.apple\.com\//i.test(s)) return undefined;
    s = s.replace(/^https:\/\/developer\.apple\.com/i, "");
  }
  if (!s.startsWith("/")) return undefined;
  s = s.split(/[?#]/, 1)[0].replace(/\/+$/, "").toLowerCase();
  return s || undefined;
}

function entryOf(path: string, p: DocPage): NavEntry {
  return {
    path,
    title: p.title || path,
    navType: p.symbolKind ?? p.role ?? "article",
    pageKind: p.pageKind,
    languages: p.availableLanguages,
    deprecated: p.deprecated,
    beta: p.availability.some((a) => a.beta),
  };
}

export function enrichmentOf(p: DocPage): Enrichment {
  const e: Enrichment = { pageKind: p.pageKind };
  if (p.abstract) e.abstract = p.abstract;
  if (p.availability.length) e.platforms = p.availability;
  if (p.declarations[0]) e.declaration = p.declarations[0].code;
  return e;
}

function clean(v: { etag?: string | undefined; lastModified?: string | undefined }) {
  const out: { etag?: string; lastModified?: string } = {};
  if (v.etag) out.etag = v.etag;
  if (v.lastModified) out.lastModified = v.lastModified;
  return out;
}
