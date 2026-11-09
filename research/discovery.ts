// Phase 1, step 2: discovery inventory.
// Usage: node research/discovery.ts [--all]
//   default: the 15 representative technologies from the plan
//   --all:   every technology listed in technologies.json (~400 requests, ~7+ min at 1 req/s)
import { json, save, requestCount } from "./http.ts";

type NavNode = { path?: string; title?: string; type?: string; external?: boolean; children?: NavNode[]; beta?: boolean; deprecated?: boolean };

const SAMPLE = ["swift", "swiftui", "uikit", "appkit", "foundation", "combine", "swiftdata", "storekit", "widgetkit", "mapkit", "avfoundation", "metal", "corelocation", "cryptokit", "human-interface-guidelines"];

const all = process.argv.includes("--all");

// 1. Root catalog
const { p: rootP, data: root } = await json<any>("/tutorials/data/documentation/technologies.json");
if (!root) throw new Error(`technologies.json failed: ${rootP.status}`);
save("technologies.json", root);

const techs: { id: string; url: string; title: string; role: string; slug: string; languages: string[] }[] = [];
const langsById = new Map<string, string[]>();
for (const g of root.sections?.[0]?.groups ?? []) for (const t of g.technologies ?? []) langsById.set(t.destination?.identifier, t.languages ?? []);
for (const [id, r] of Object.entries<any>(root.references)) {
  if (r.type !== "topic") continue;
  const url: string = r.url;
  techs.push({ id, url, title: r.title, role: r.role, slug: url.split("/").filter(Boolean).pop()!.toLowerCase(), languages: langsById.get(id) ?? [] });
}
const prefixes = count(techs.map((t) => "/" + t.url.split("/")[1]));
console.log(`technologies.json: ${techs.length} topic refs, url prefixes`, prefixes, "roles", count(techs.map((t) => t.role)));

// 2. Navigator index per technology
const chosen = all ? techs : SAMPLE.map((s) => techs.find((t) => t.slug === s) ?? { id: "", url: "", title: s, role: "?", slug: s, languages: [] });
const rows: any[] = [];
const globalPaths = new Map<string, string>(); // path -> type
const globalTypes = new Map<string, number>();

for (const t of chosen) {
  const { p, data } = await json<any>(`/tutorials/data/index/${t.slug}`);
  const row: any = { slug: t.slug, title: t.title, techUrl: t.url, status: p.status, bytes: p.bytes, ms: p.ms, location: p.location };
  if (data) {
    const langs = data.interfaceLanguages ?? {};
    row.archives = data.includedArchiveIdentifiers;
    for (const [lang, tree] of Object.entries<NavNode[]>(langs)) {
      const stats = { nodes: 0, paths: new Set<string>(), external: 0, types: new Map<string, number>(), prefixes: new Map<string, number>(), deprecated: 0, beta: 0 };
      walk(tree, (n) => {
        stats.nodes++;
        if (n.type) stats.types.set(n.type, (stats.types.get(n.type) ?? 0) + 1);
        if (n.external) stats.external++;
        if (n.deprecated) stats.deprecated++;
        if (n.beta) stats.beta++;
        if (n.path && n.type !== "groupMarker") {
          stats.paths.add(n.path);
          const pre = "/" + n.path.split("/")[1];
          stats.prefixes.set(pre, (stats.prefixes.get(pre) ?? 0) + 1);
          if (!n.external && !globalPaths.has(n.path)) {
            globalPaths.set(n.path, n.type ?? "?");
            globalTypes.set(n.type ?? "?", (globalTypes.get(n.type ?? "?") ?? 0) + 1);
          }
        }
      });
      row[lang] = { nodes: stats.nodes, uniquePaths: stats.paths.size, external: stats.external, deprecated: stats.deprecated, beta: stats.beta, prefixes: Object.fromEntries(stats.prefixes), types: Object.fromEntries([...stats.types].sort((a, b) => b[1] - a[1])) };
    }
    if (!all) save(`index-${t.slug}.json`, data);
  }
  rows.push(row);
  console.log(`${t.slug.padEnd(28)} ${p.status} ${(p.bytes / 1024).toFixed(0).padStart(6)} KB  swift=${row.swift?.uniquePaths ?? "-"} occ=${row.occ?.uniquePaths ?? "-"}${p.location ? " -> " + p.location : ""}`);
}

const ok = rows.filter((r) => r.status === 200);
const summary = {
  mode: all ? "all" : "sample",
  date: new Date().toISOString(),
  technologies: techs.length,
  probed: rows.length,
  indexOk: ok.length,
  indexFailed: rows.filter((r) => r.status !== 200).map((r) => ({ slug: r.slug, status: r.status, url: r.techUrl })),
  totalIndexBytes: rows.reduce((s, r) => s + (r.bytes ?? 0), 0),
  uniqueInternalPaths: globalPaths.size,
  typesAcrossUniquePaths: Object.fromEntries([...globalTypes].sort((a, b) => b[1] - a[1])),
  pathPrefixes: count([...globalPaths.keys()].map((k) => "/" + k.split("/")[1])),
  requests: requestCount,
};
save(`discovery-${summary.mode}.json`, { summary, rows, technologies: techs });
console.log(JSON.stringify(summary, null, 2));

function walk(nodes: NavNode[], fn: (n: NavNode) => void) {
  for (const n of nodes) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}
function count(xs: string[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}
