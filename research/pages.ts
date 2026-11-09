// Phase 1, step 3: page-JSON survey across page kinds.
// Usage: node research/pages.ts   (run discovery.ts first: it reads the saved sample indexes from OUT_DIR)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { json, save, OUT_DIR, requestCount } from "./http.ts";

type NavNode = { path?: string; title?: string; type?: string; external?: boolean; deprecated?: boolean; children?: NavNode[] };

// Nodes from the saved sample indexes, tagged with language tree.
const nodes: (NavNode & { lang: string; tech: string })[] = [];
for (const tech of ["swift", "swiftui", "uikit", "foundation", "storekit", "metal", "avfoundation", "cryptokit"]) {
  const f = join(OUT_DIR, `index-${tech}.json`);
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, "utf8"));
  for (const [lang, tree] of Object.entries<NavNode[]>(d.interfaceLanguages)) walk(tree, (n) => n.path && !n.external && nodes.push({ ...n, lang, tech }));
}
const swiftPaths = new Set(nodes.filter((n) => n.lang === "swift").map((n) => n.path));
const pick = (pred: (n: (typeof nodes)[0]) => boolean) => nodes.find(pred)?.path;

// Fixed paths plus picks by kind from the real indexes (never hand-invented symbol URLs beyond the spec's smoke tests).
const targets: Record<string, string | undefined> = {
  protocol: "/documentation/swiftui/view",
  struct: "/documentation/swiftui/navigationstack",
  swiftStdlib: "/documentation/swift/string",
  foundationStruct: "/documentation/foundation/url",
  overloadHash: pick((n) => n.tech === "swiftui" && n.type === "method" && /-[0-9a-z]{4,6}$/.test(n.path!)),
  init: pick((n) => n.tech === "swiftui" && n.type === "init"),
  enumCase: pick((n) => n.tech === "storekit" && n.type === "case"),
  op: pick((n) => n.tech === "swift" && n.type === "op"),
  macro: pick((n) => n.type === "macro"),
  typealias: pick((n) => n.tech === "cryptokit" && n.type === "typealias"),
  property: pick((n) => n.tech === "avfoundation" && n.type === "property" && n.lang === "swift"),
  deprecated: pick((n) => n.tech === "uikit" && n.deprecated === true && n.lang === "swift"),
  occOnly: pick((n) => n.tech === "foundation" && n.lang === "occ" && !swiftPaths.has(n.path) && n.type === "method"),
  article: pick((n) => n.tech === "swiftui" && n.type === "article"),
  sampleCode: pick((n) => n.tech === "metal" && n.type === "sampleCode"),
  collection: pick((n) => n.tech === "uikit" && n.type === "collection"),
  frameworkRoot: "/documentation/storekit",
  hig: "/design/human-interface-guidelines/color",
  higRoot: "/design/human-interface-guidelines",
  tutorialsRoot: "/tutorials/swiftui",
  tutorialPage: "/tutorials/swiftui/creating-and-combining-views",
  techOverview: "/documentation/technologyoverviews",
  swiftBook: "/documentation/swift-book",
};

const rows: any[] = [];
for (const [kind, path] of Object.entries(targets)) {
  if (!path) {
    rows.push({ kind, path: null, note: "no candidate in sampled indexes" });
    continue;
  }
  const dataPath = toDataPath(path);
  const { p, data } = await json<any>(dataPath);
  const row: any = { kind, path, dataPath, status: p.status, bytes: p.bytes, location: p.location, contentType: p.contentType };
  if (data) {
    save(`page-${kind}.json`, data);
    row.analysis = analyze(data);
  }
  rows.push(row);
  console.log(`${kind.padEnd(16)} ${p.status} ${(p.bytes / 1024).toFixed(0).padStart(5)} KB ${path}${p.location ? " -> " + p.location : ""}`);
}
save("pages-survey.json", { date: new Date().toISOString(), requests: requestCount, rows });

// Observed mapping, to be confirmed: /documentation/x/y -> /tutorials/data/documentation/x/y.json
function toDataPath(path: string) {
  return `/tutorials/data${path.toLowerCase()}.json`;
}

function analyze(d: any) {
  const m = d.metadata ?? {};
  const inline = new Set<string>();
  const blocks = new Set<string>();
  collectTypes(d.primaryContentSections, blocks, inline);
  collectTypes(d.sections, blocks, inline);
  const decl = (d.primaryContentSections ?? []).find((s: any) => s.kind === "declarations");
  return {
    schemaVersion: d.schemaVersion,
    kind: d.kind,
    identifier: d.identifier,
    topKeys: Object.keys(d),
    metadataKeys: Object.keys(m),
    role: m.role,
    roleHeading: m.roleHeading,
    symbolKind: m.symbolKind,
    title: m.title,
    externalID: m.externalID,
    modules: m.modules?.map((x: any) => x.name),
    platforms: m.platforms,
    hasAbstract: Array.isArray(d.abstract) && d.abstract.length > 0,
    abstractText: plain(d.abstract).slice(0, 160),
    deprecationSummary: !!d.deprecationSummary,
    primarySections: (d.primaryContentSections ?? []).map((s: any) => s.kind),
    declaration: decl?.declarations?.map((x: any) => ({ languages: x.languages, platforms: x.platforms, text: x.tokens?.map((t: any) => t.text).join("") })),
    declarationTokenKinds: [...new Set(decl?.declarations?.flatMap((x: any) => x.tokens?.map((t: any) => t.kind)) ?? [])],
    sections: (d.sections ?? []).map((s: any) => s.kind),
    topicSections: d.topicSections?.length ?? 0,
    topicSectionsStyle: d.topicSectionsStyle,
    relationshipsSections: d.relationshipsSections?.map((s: any) => s.type),
    seeAlsoSections: d.seeAlsoSections?.length ?? 0,
    variants: d.variants?.map((v: any) => ({ traits: v.traits, paths: v.paths })),
    hierarchy: d.hierarchy?.paths?.[0]?.length,
    referenceTypes: countBy(Object.values<any>(d.references ?? {}).map((r) => r.type)),
    blockTypes: [...blocks].sort(),
    inlineTypes: [...inline].sort(),
  };
}

function collectTypes(x: any, blocks: Set<string>, inline: Set<string>, depth = 0) {
  if (Array.isArray(x)) return x.forEach((y) => collectTypes(y, blocks, inline, depth));
  if (!x || typeof x !== "object") return;
  if (typeof x.type === "string") (x.inlineContent || x.type === "codeListing" || x.type === "heading" || x.type === "aside" || x.type === "unorderedList" || x.type === "orderedList" || x.type === "table" || x.type === "paragraph" ? blocks : inline).add(x.type);
  for (const v of Object.values(x)) if (typeof v === "object") collectTypes(v, blocks, inline, depth + 1);
}
function plain(x: any): string {
  if (Array.isArray(x)) return x.map(plain).join("");
  if (!x || typeof x !== "object") return "";
  if (x.type === "text") return x.text;
  if (x.type === "codeVoice") return x.code;
  return plain(x.inlineContent ?? []);
}
function countBy(xs: string[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}
function walk(ns: NavNode[], fn: (n: NavNode) => void) {
  for (const n of ns) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}
