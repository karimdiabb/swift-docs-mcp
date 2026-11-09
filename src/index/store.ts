// Local search index on node:sqlite (built into Node 22+, FTS5 included).
// One row per documentation page; enrichment fields (abstract, platforms, declaration) fill in lazily.
// Removed pages are kept with removed_at set, so refreshes can report them and resurrect them if they return.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Availability, PageKind } from "../apple/types.ts";
import { symbolName, wordsOf, type NavEntry } from "./navigator.ts";

export const SCHEMA_VERSION = "1";
const ORIGIN = "https://developer.apple.com";
// Ranking tiers. Code types (Swift/ObjC) beat same-named collections or JSON schemas: on the real index "Text"
// otherwise ranked TVML's `text` collection and Apple News' `Text` object above SwiftUI.Text.
const CODE_TYPES = ["struct", "class", "protocol", "enum", "actor", "macro"];
const OTHER_TOP_LEVEL = ["module", "collection", "article", "sampleCode", "typealias", "httpRequest", "dictionarySymbol"];
const PLATFORMS: Record<string, string> = { ios: "iOS", ipados: "iPadOS", macos: "macOS", watchos: "watchOS", tvos: "tvOS", visionos: "visionOS", maccatalyst: "Mac Catalyst", "mac catalyst": "Mac Catalyst" };

export class IndexUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexUnavailable";
  }
}

export type RootStatus = "ok" | "partial" | "error" | "removed" | "pending";
export type RootRow = {
  path: string;
  slug: string;
  title: string;
  method: "navigator" | "walk";
  status: RootStatus;
  role?: string;
  etag?: string;
  lastModified?: string;
  checkedAt?: number;
  changedAt?: number;
  error?: string;
  docCount?: number;
};

export type Enrichment = { abstract?: string; platforms?: Availability[]; declaration?: string; title?: string; pageKind?: PageKind };

export type IndexDoc = NavEntry & {
  root: string;
  name: string;
  abstract?: string;
  platforms?: Availability[];
  declaration?: string;
  enrichedAt?: number;
  removedAt?: number;
};

export type SearchHit = {
  path: string;
  url: string;
  title: string;
  name: string;
  navType: string;
  pageKind: PageKind;
  framework: string;
  frameworkSlug: string;
  languages: string[];
  deprecated: boolean;
  beta: boolean;
  abstract?: string;
  platforms?: Availability[];
  declaration?: string;
};

export type SearchOptions = { framework?: string; platform?: string; kind?: PageKind; limit?: number; cursor?: string };
export type SearchResult = { hits: SearchHit[]; total: number; nextCursor?: string; platformUnknown?: number; matchedAllWords: boolean };

export type IndexStats = {
  file: string;
  docs: number;
  removed: number;
  enriched: number;
  byKind: Record<string, number>;
  rootsTotal: number;
  rootsByStatus: Record<string, number>;
  frameworksWithDocs: number;
  platforms: string[];
};

export class IndexStore {
  private readonly db: DatabaseSync;
  readonly file: string;

  private constructor(db: DatabaseSync, file: string) {
    this.db = db;
    this.file = file;
  }

  static open(file: string, o: { readOnly?: boolean } = {}): IndexStore {
    if (o.readOnly && !existsSync(file)) throw new IndexUnavailable(`no index at ${file}; run the index build command first`);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: !!o.readOnly });
      const store = new IndexStore(db, file);
      store.init(!o.readOnly);
      return store;
    } catch (e) {
      try {
        db?.close();
      } catch {}
      if (e instanceof IndexUnavailable) throw e;
      throw new IndexUnavailable(`index at ${file} cannot be opened (${(e as Error).message}); rebuild it with the index build command`);
    }
  }

  close() {
    this.db.close();
  }

  private init(writable: boolean) {
    if (writable) {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS roots (
          path TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, role TEXT, method TEXT NOT NULL, status TEXT NOT NULL,
          etag TEXT, last_modified TEXT, checked_at INTEGER, changed_at INTEGER, error TEXT, doc_count INTEGER);
        CREATE TABLE IF NOT EXISTS docs (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL, title TEXT NOT NULL, name TEXT NOT NULL,
          nav_type TEXT NOT NULL, page_kind TEXT NOT NULL, languages TEXT NOT NULL, deprecated INTEGER NOT NULL, beta INTEGER NOT NULL,
          abstract TEXT, platforms TEXT, declaration TEXT, enriched_at INTEGER, seen_at INTEGER NOT NULL, removed_at INTEGER);
        CREATE INDEX IF NOT EXISTS docs_root ON docs(root, seen_at);
        CREATE INDEX IF NOT EXISTS docs_name ON docs(name);
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, words, framework, abstract, tokenize = 'unicode61 remove_diacritics 2');
      `);
      const v = this.getMeta("schemaVersion");
      if (v === undefined) this.setMeta("schemaVersion", SCHEMA_VERSION);
    }
    const v = this.getMeta("schemaVersion");
    if (v !== SCHEMA_VERSION) throw new IndexUnavailable(`index schema version ${v ?? "missing"} does not match ${SCHEMA_VERSION}; rebuild the index`);
  }

  // ---------- meta and roots ----------

  getMeta(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? undefined;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  upsertRoot(r: RootRow) {
    this.db
      .prepare(
        `INSERT INTO roots(path, slug, title, role, method, status, etag, last_modified, checked_at, changed_at, error, doc_count)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET slug=excluded.slug, title=excluded.title, role=excluded.role, method=excluded.method,
           status=excluded.status, etag=excluded.etag, last_modified=excluded.last_modified, checked_at=excluded.checked_at,
           changed_at=excluded.changed_at, error=excluded.error, doc_count=excluded.doc_count`,
      )
      .run(r.path, r.slug, r.title, r.role ?? null, r.method, r.status, r.etag ?? null, r.lastModified ?? null, r.checkedAt ?? null, r.changedAt ?? null, r.error ?? null, r.docCount ?? null);
  }

  getRoot(path: string): RootRow | undefined {
    const r = this.db.prepare("SELECT * FROM roots WHERE path = ?").get(path) as any;
    return r ? rootFromRow(r) : undefined;
  }

  listRoots(): RootRow[] {
    return (this.db.prepare("SELECT * FROM roots ORDER BY path").all() as any[]).map(rootFromRow);
  }

  rootDocCount(root: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM docs WHERE root = ? AND removed_at IS NULL").get(root) as any).n;
  }

  // ---------- docs ----------

  /** Insert or update pages for a root. Existing enrichment is kept; a removed page that reappears is restored. */
  upsertEntries(root: string, entries: (NavEntry & Enrichment)[], seenAt: number, enrichedAt?: number) {
    // Some navigator indexes list pages of other roots without marking them external (Distributed lists the
    // Swift standard library). Ownership goes to the root whose path contains the page, in either order.
    const frameworkText = new Map<string, string>();
    const frameworkOf = (r: string) => {
      let f = frameworkText.get(r);
      if (f === undefined) {
        const row = this.getRoot(r);
        f = row ? `${row.title} ${row.slug}` : r;
        frameworkText.set(r, f);
      }
      return f;
    };
    const upsert = this.db.prepare(
      `INSERT INTO docs(path, root, title, name, nav_type, page_kind, languages, deprecated, beta, abstract, platforms, declaration, enriched_at, seen_at, removed_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET
         root = CASE WHEN excluded.path = excluded.root OR substr(excluded.path, 1, length(excluded.root) + 1) = excluded.root || '/' THEN excluded.root ELSE docs.root END,
         title = excluded.title, nav_type = excluded.nav_type, page_kind = excluded.page_kind, languages = excluded.languages,
         deprecated = excluded.deprecated, beta = excluded.beta, seen_at = excluded.seen_at, removed_at = NULL,
         abstract = coalesce(excluded.abstract, docs.abstract), platforms = coalesce(excluded.platforms, docs.platforms),
         declaration = coalesce(excluded.declaration, docs.declaration), enriched_at = coalesce(excluded.enriched_at, docs.enriched_at)
       RETURNING id, abstract, root`,
    );
    const delFts = this.db.prepare("DELETE FROM docs_fts WHERE rowid = ?");
    const insFts = this.db.prepare("INSERT INTO docs_fts(rowid, title, words, framework, abstract) VALUES(?, ?, ?, ?, ?)");
    this.tx(() => {
      for (const e of entries) {
        const name = symbolName(e.path);
        const row = upsert.get(
          e.path, root, e.title, name, e.navType, e.pageKind, e.languages.join(","), e.deprecated ? 1 : 0, e.beta ? 1 : 0,
          e.abstract ?? null, e.platforms ? JSON.stringify(e.platforms) : null, e.declaration ?? null, e.abstract || e.platforms || e.declaration ? (enrichedAt ?? seenAt) : null, seenAt,
        ) as { id: number; abstract: string | null; root: string };
        delFts.run(row.id);
        insFts.run(row.id, e.title, wordsFor(e.title, name), frameworkOf(row.root), row.abstract ?? "");
      }
    });
  }

  /** After a 304 for a root: everything it lists is still there. */
  touchRoot(root: string, seenAt: number) {
    this.db.prepare("UPDATE docs SET seen_at = ? WHERE root = ? AND removed_at IS NULL").run(seenAt, root);
  }

  /** Mark pages of `root` not seen since `syncStart` as removed. Returns how many. */
  markRemovedNotSeen(root: string, syncStart: number, now: number): number {
    return Number(this.db.prepare("UPDATE docs SET removed_at = ? WHERE root = ? AND seen_at < ? AND removed_at IS NULL").run(now, root, syncStart).changes);
  }

  countNotSeen(root: string, syncStart: number): number {
    return (this.db.prepare("SELECT count(*) AS n FROM docs WHERE root = ? AND seen_at < ? AND removed_at IS NULL").get(root, syncStart) as any).n;
  }

  markRootRemoved(root: string, now: number): number {
    return Number(this.db.prepare("UPDATE docs SET removed_at = ? WHERE root = ? AND removed_at IS NULL").run(now, root).changes);
  }

  enrich(path: string, e: Enrichment, at: number): boolean {
    const row = this.db.prepare("SELECT id, title, name, root FROM docs WHERE path = ?").get(path) as any;
    if (!row) return false;
    this.db
      .prepare(
        `UPDATE docs SET abstract = coalesce(?, abstract), platforms = coalesce(?, platforms), declaration = coalesce(?, declaration),
           page_kind = coalesce(?, page_kind), enriched_at = ? WHERE id = ?`,
      )
      .run(e.abstract ?? null, e.platforms ? JSON.stringify(e.platforms) : null, e.declaration ?? null, e.pageKind ?? null, at, row.id);
    const root = this.getRoot(row.root);
    const abstract = (this.db.prepare("SELECT abstract FROM docs WHERE id = ?").get(row.id) as any).abstract ?? "";
    this.tx(() => {
      this.db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(row.id);
      this.db.prepare("INSERT INTO docs_fts(rowid, title, words, framework, abstract) VALUES(?, ?, ?, ?, ?)").run(row.id, row.title, wordsFor(row.title, row.name), root ? `${root.title} ${root.slug}` : row.root, abstract);
    });
    return true;
  }

  get(path: string): IndexDoc | undefined {
    const r = this.db.prepare("SELECT * FROM docs WHERE path = ?").get(path) as any;
    return r ? docFromRow(r) : undefined;
  }

  pendingEnrichment(o: { kinds: string[]; framework?: string; limit: number }): string[] {
    const params: any[] = [...o.kinds];
    let sql = `SELECT d.path FROM docs d LEFT JOIN roots r ON r.path = d.root WHERE d.enriched_at IS NULL AND d.removed_at IS NULL AND d.nav_type IN (${o.kinds.map(() => "?").join(",") || "''"})`;
    if (o.framework) {
      sql += " AND (r.slug = ? OR lower(r.title) = ?)";
      params.push(o.framework.toLowerCase(), o.framework.toLowerCase());
    }
    sql += " ORDER BY length(d.path), d.path LIMIT ?";
    params.push(o.limit);
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => r.path);
  }

  // ---------- search ----------

  search(query: string, o: SearchOptions = {}): SearchResult {
    const limit = Math.max(1, Math.min(30, o.limit ?? 10));
    const offset = decodeCursor(o.cursor);
    const words = queryWords(query);
    if (!words.length) return { hits: [], total: 0, matchedAllWords: true };

    let matchedAllWords = true;
    let r = this.runSearch(words, "AND", query, o, limit, offset);
    if (r.total === 0 && words.length > 1) {
      matchedAllWords = false;
      r = this.runSearch(words, "OR", query, o, limit, offset);
    }
    const out: SearchResult = { hits: r.hits, total: r.total, matchedAllWords };
    if (offset + r.hits.length < r.total) out.nextCursor = encodeCursor(offset + r.hits.length);
    if (o.platform) out.platformUnknown = r.platformUnknown;
    return out;
  }

  private runSearch(words: string[], joiner: "AND" | "OR", raw: string, o: SearchOptions, limit: number, offset: number) {
    const match = words.map(ftsTerm).join(` ${joiner} `);
    const where: string[] = ["docs_fts MATCH ?", "d.removed_at IS NULL"];
    const params: any[] = [match];
    if (o.framework) {
      const f = o.framework.toLowerCase().trim();
      where.push("(r.slug = ? OR lower(r.title) = ? OR d.path = ? OR d.path LIKE ?)");
      params.push(f, f, `/documentation/${f}`, `/documentation/${f}/%`);
    }
    if (o.kind) {
      where.push("d.page_kind = ?");
      params.push(o.kind);
    }
    const base = `FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid LEFT JOIN roots r ON r.path = d.root WHERE ${where.join(" AND ")}`;

    let platformUnknown = 0;
    let platformWhere = "";
    const platformParams: any[] = [];
    if (o.platform) {
      const p = PLATFORMS[o.platform.toLowerCase().trim()] ?? o.platform;
      platformUnknown = (this.db.prepare(`SELECT count(*) AS n ${base} AND d.platforms IS NULL`).get(...params) as any).n;
      platformWhere = ` AND EXISTS (SELECT 1 FROM json_each(d.platforms) j WHERE json_extract(j.value, '$.platform') = ? AND coalesce(json_extract(j.value, '$.unavailable'), 0) = 0)`;
      platformParams.push(p);
    }

    const total = (this.db.prepare(`SELECT count(*) AS n ${base}${platformWhere}`).get(...params, ...platformParams) as any).n;
    const q = raw.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT d.*, r.title AS root_title, r.slug AS root_slug,
           bm25(docs_fts, 10.0, 6.0, 2.0, 1.0)
           - CASE WHEN d.name = ? OR lower(d.title) = ? THEN 50 ELSE 0 END
           - CASE WHEN d.nav_type IN (${CODE_TYPES.map(() => "?").join(",")}) AND d.languages <> 'data' THEN 8
                  WHEN d.nav_type IN (${OTHER_TOP_LEVEL.map(() => "?").join(",")}) THEN 3 ELSE 0 END
           + CASE WHEN d.deprecated = 1 THEN 5 ELSE 0 END AS score
         ${base}${platformWhere}
         ORDER BY score, length(d.path), d.path LIMIT ? OFFSET ?`,
      )
      .all(q, q, ...CODE_TYPES, ...OTHER_TOP_LEVEL, ...params, ...platformParams, limit, offset) as any[];
    return { hits: rows.map(hitFromRow), total, platformUnknown };
  }

  /**
   * Candidates for a symbol such as "NavigationStack", "View.onAppear", "SwiftUI.View" or "frame(width:height:alignment:)".
   * Matches the last component by exact name or base name (all overloads); qualifiers must appear as earlier path segments.
   */
  findSymbol(symbol: string, o: { framework?: string } = {}): IndexDoc[] {
    const parts = splitSymbol(symbol);
    if (!parts.length) return [];
    const last = parts.at(-1)!.toLowerCase();
    const qualifiers = parts.slice(0, -1).map((p) => p.toLowerCase());
    const base = last.includes("(") ? undefined : last;
    const rows = this.db
      .prepare(
        `SELECT d.*, r.slug AS root_slug FROM docs d LEFT JOIN roots r ON r.path = d.root
         WHERE d.removed_at IS NULL AND d.page_kind = 'api' AND (d.name = ? OR (? IS NOT NULL AND d.name LIKE ? ESCAPE '\\'))
         ORDER BY length(d.path), d.path LIMIT 500`,
      )
      .all(last, base ?? null, base ? `${likeEscape(base)}(%` : "") as any[];
    const fw = o.framework?.toLowerCase().trim();
    const candidates = rows.filter((r) => {
      const segs = r.path.split("/").filter(Boolean).slice(1).map((s: string) => symbolName(`/${s}`));
      if (fw && segs[0] !== fw && r.root_slug !== fw) return false;
      // Qualifiers are the direct parent chain: "SwiftUI.View.onAppear" -> segments end with [swiftui, view].
      const before = segs.slice(0, -1);
      if (qualifiers.length > before.length) return false;
      return qualifiers.every((q, k) => before[before.length - qualifiers.length + k] === q);
    });
    const exact = candidates.filter((r) => r.name === last);
    return (exact.length ? exact : candidates).map(docFromRow);
  }

  stats(): IndexStats {
    const one = (sql: string) => (this.db.prepare(sql).get() as any).n as number;
    const byKind: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT page_kind AS k, count(*) AS n FROM docs WHERE removed_at IS NULL GROUP BY page_kind").all() as any[]) byKind[r.k] = r.n;
    const rootsByStatus: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT status AS s, count(*) AS n FROM roots GROUP BY status").all() as any[]) rootsByStatus[r.s] = r.n;
    const platforms = (this.db
      .prepare("SELECT DISTINCT json_extract(j.value, '$.platform') AS p FROM docs d, json_each(d.platforms) j WHERE d.platforms IS NOT NULL AND d.removed_at IS NULL ORDER BY p")
      .all() as any[]).map((r) => r.p).filter(Boolean);
    return {
      file: this.file,
      docs: one("SELECT count(*) AS n FROM docs WHERE removed_at IS NULL"),
      removed: one("SELECT count(*) AS n FROM docs WHERE removed_at IS NOT NULL"),
      enriched: one("SELECT count(*) AS n FROM docs WHERE enriched_at IS NOT NULL AND removed_at IS NULL"),
      byKind,
      rootsTotal: one("SELECT count(*) AS n FROM roots"),
      rootsByStatus,
      frameworksWithDocs: one("SELECT count(DISTINCT root) AS n FROM docs WHERE removed_at IS NULL"),
      platforms,
    };
  }

  private tx(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

// ---------- helpers ----------

function wordsFor(title: string, name: string): string {
  return `${wordsOf(title)} ${wordsOf(name)} ${name.replace(/[^\p{L}\p{N}]+/gu, " ")}`.trim();
}

/** Raw words of the query (letters/digits only). FTS syntax can never get through. */
function queryWords(q: string): string[] {
  const raw = (q.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12);
  return [...new Set(raw)];
}

/** One query word -> FTS term: the word as a prefix, or its camelCase parts all as prefixes. */
function ftsTerm(w: string): string {
  const lower = w.toLowerCase().replace(/_/g, "");
  const parts = wordsOf(w).split(" ").filter(Boolean);
  const whole = `"${lower}"*`;
  if (parts.length <= 1) return whole;
  return `(${whole} OR (${parts.map((p) => `"${p}"*`).join(" AND ")}))`;
}

function splitSymbol(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "." && depth === 0) {
      if (cur) parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => p.replace(/\s+/g, ""));
}

function likeEscape(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function encodeCursor(n: number) {
  return Buffer.from(`o:${n}`).toString("base64url");
}

function decodeCursor(c?: string): number {
  if (!c) return 0;
  const m = Buffer.from(c, "base64url").toString().match(/^o:(\d{1,7})$/);
  return m ? Number(m[1]) : 0;
}

function rootFromRow(r: any): RootRow {
  const out: RootRow = { path: r.path, slug: r.slug, title: r.title ?? r.slug, method: r.method, status: r.status };
  if (r.role) out.role = r.role;
  if (r.etag) out.etag = r.etag;
  if (r.last_modified) out.lastModified = r.last_modified;
  if (r.checked_at != null) out.checkedAt = r.checked_at;
  if (r.changed_at != null) out.changedAt = r.changed_at;
  if (r.error) out.error = r.error;
  if (r.doc_count != null) out.docCount = r.doc_count;
  return out;
}

function docFromRow(r: any): IndexDoc {
  const d: IndexDoc = {
    path: r.path,
    root: r.root,
    title: r.title,
    name: r.name,
    navType: r.nav_type,
    pageKind: r.page_kind,
    languages: String(r.languages).split(",").filter(Boolean),
    deprecated: r.deprecated === 1,
    beta: r.beta === 1,
  };
  if (r.abstract) d.abstract = r.abstract;
  if (r.platforms) d.platforms = JSON.parse(r.platforms);
  if (r.declaration) d.declaration = r.declaration;
  if (r.enriched_at != null) d.enrichedAt = r.enriched_at;
  if (r.removed_at != null) d.removedAt = r.removed_at;
  return d;
}

function hitFromRow(r: any): SearchHit {
  const d = docFromRow(r);
  const h: SearchHit = {
    path: d.path,
    url: ORIGIN + d.path,
    title: d.title,
    name: d.name,
    navType: d.navType,
    pageKind: d.pageKind,
    framework: r.root_title ?? d.root,
    frameworkSlug: r.root_slug ?? d.root,
    languages: d.languages,
    deprecated: d.deprecated,
    beta: d.beta,
  };
  if (d.abstract) h.abstract = d.abstract;
  if (d.platforms) h.platforms = d.platforms;
  if (d.declaration) h.declaration = d.declaration;
  return h;
}
