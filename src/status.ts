// Coverage and freshness report, shared by the CLI (`index status`) and the get_apple_docs_status tool.
// It never claims completeness: Apple publishes no verified inventory of its documentation.
import type { CacheStats, DocCache } from "./cache/cache.ts";
import type { IndexStats, IndexStore, RootRow } from "./index/store.ts";

export const KNOWN_GAPS = [
  "Apple publishes no complete, verified inventory of its documentation; coverage is what Apple's own catalog (technologies.json) and navigator indexes list, plus link walks for roots without an index.",
  "Live Apple search is not used: developer.apple.com/search is disallowed by robots.txt. Search runs on the local index only.",
  "Abstracts, platforms and declarations are only known for pages fetched at least once (lazily, or via `index enrich`). The platform filter lists confirmed pages first and marks pages without that data as 'availability not yet known'.",
  "Tutorials have no catalog endpoint; only tutorial collections linked from indexed pages (or configured seeds) are included.",
  "From docs.swift.org, collections that duplicate an Apple root (Standard Library, Testing) are skipped in favour of Apple's copy.",
  "Apple's retired Documentation Archive (/library/archive) is not included (static HTML only).",
  "Localized documentation is not included; Apple's JSON is English only.",
  "Sample-code download links are not built (the download host is unverified); the sample's page is linked instead.",
  "WWDC videos, forums and release notes outside the documentation catalog are not included.",
];

export type Status = {
  sources: string[];
  searchMode: string;
  index: {
    available: boolean;
    error?: string;
    file?: string;
    stats?: IndexStats;
    lastBuild?: number;
    lastRefresh?: number;
    lastEnrich?: string;
    syncState?: string;
    problemRoots: RootRow[];
  };
  cache: CacheStats;
  gaps: string[];
  recentErrors: string[];
};

export function buildStatus(o: { store: IndexStore | undefined; storeError?: string; cache: DocCache; recentErrors: string[] }): Status {
  const s: Status = {
    sources: [
      "developer.apple.com DocC JSON: technologies.json (root catalog), /tutorials/data/index/<root> (navigator indexes), /tutorials/data/<page>.json (pages). These endpoints are not publicly documented by Apple (observed behaviour).",
      "docs.swift.org DocC JSON: /latest/index/index.json (navigator for all swift.org collections, including The Swift Programming Language), /latest/data/<page>.json (pages). Observed, undocumented.",
    ],
    searchMode: "local index (SQLite FTS5) with live page retrieval from Apple and a local cache",
    index: { available: !!o.store, problemRoots: [] },
    cache: o.cache.stats(),
    gaps: [...KNOWN_GAPS],
    recentErrors: o.recentErrors.slice(-20),
  };
  if (!o.store) {
    s.index.error = o.storeError ?? "index not available";
    return s;
  }
  const st = o.store;
  s.index.file = st.file;
  s.index.stats = st.stats();
  const num = (k: string) => {
    const v = st.getMeta(k);
    return v ? Number(v) : undefined;
  };
  const lb = num("lastBuild");
  const lr = num("lastRefresh");
  if (lb) s.index.lastBuild = lb;
  if (lr) s.index.lastRefresh = lr;
  const le = st.getMeta("lastEnrich");
  if (le) s.index.lastEnrich = le;
  const ss = st.getMeta("syncState");
  if (ss) s.index.syncState = ss;
  s.index.problemRoots = st.listRoots().filter((r) => r.status === "error" || r.status === "partial" || r.status === "pending");
  const last = st.getMeta("lastSync");
  if (last) {
    try {
      for (const e of JSON.parse(last).errors ?? []) s.recentErrors.push(`last sync: ${e}`);
    } catch {}
  }
  return s;
}

export function renderStatus(s: Status): string {
  const out: string[] = ["# Apple documentation MCP: status"];
  out.push(`## Sources\n\n${s.sources.map((x) => `- ${x}`).join("\n")}\n\nSearch: ${s.searchMode}.`);

  const i = s.index;
  if (!i.available) {
    out.push(`## Index\n\nIndex: not available. ${i.error ?? ""}\n\nBuild it with: \`swift-docs-mcp index build\` (or \`npm run index:build\` in the project). Page retrieval by URL still works without it.`);
  } else {
    const st = i.stats!;
    const pct = st.docs ? Math.round((st.enriched / st.docs) * 100) : 0;
    const lines = [
      `- File: ${i.file}`,
      `- Last build: ${i.lastBuild ? new Date(i.lastBuild).toISOString() : "never"}`,
      `- Last refresh: ${i.lastRefresh ? new Date(i.lastRefresh).toISOString() : "never"}`,
      `- Last sync state: ${i.syncState ?? "unknown"}${i.syncState === "running" ? " (a sync is running or was interrupted; results may be incomplete)" : ""}`,
      `- Pages indexed: ${st.docs}${st.removed ? ` (plus ${st.removed} marked removed)` : ""}`,
      `- With abstract/platform data: ${st.enriched} (${pct}%)`,
      `- By kind: ${Object.entries(st.byKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
      `- Roots (frameworks/collections): ${st.rootsTotal} known, ${st.frameworksWithDocs} with pages; by status: ${Object.entries(st.rootsByStatus).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
      `- Platforms seen in enriched pages: ${st.platforms.join(", ") || "none yet"}`,
    ];
    out.push(`## Index\n\n${lines.join("\n")}\n\nCoverage is not a verified complete inventory of Apple's documentation; see Known gaps.`);
    if (i.problemRoots.length) {
      const shown = i.problemRoots.slice(0, 30).map((r) => `- ${r.title} (${r.path}): ${r.status}${r.error ? ` — ${r.error}` : ""}`);
      out.push(`## Roots with problems (${i.problemRoots.length})\n\n${shown.join("\n")}${i.problemRoots.length > 30 ? `\n- …and ${i.problemRoots.length - 30} more` : ""}`);
    }
  }

  const c = s.cache;
  out.push(`## Cache\n\n- Directory: ${c.dir}\n- Pages cached: ${c.entries} (${(c.bytes / 1024 / 1024).toFixed(1)} MB)${c.corruptRemoved ? `\n- Corrupt entries removed this session: ${c.corruptRemoved}` : ""}`);
  out.push(`## Known gaps\n\n${s.gaps.map((g) => `- ${g}`).join("\n")}`);
  out.push(`## Recent errors\n\n${s.recentErrors.length ? s.recentErrors.map((e) => `- ${e}`).join("\n") : "- none"}`);
  return out.join("\n\n");
}
