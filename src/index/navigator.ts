// Parse a DocC navigator index (/tutorials/data/index/<slug>) into flat, deduplicated page entries.
// Observed shape (Phase 1): { interfaceLanguages: { swift: Node[], occ: Node[] } }, Node =
// { title, type, path?, external?, deprecated?, beta?, children? }. External nodes belong to another root.
import type { PageKind } from "../apple/types.ts";

export type NavEntry = {
  path: string;
  title: string;
  navType: string;
  pageKind: PageKind;
  languages: string[];
  deprecated: boolean;
  beta: boolean;
};

const API_LIKE_DEFAULT: PageKind = "api";
const TUTORIAL_TYPES = new Set(["project", "tutorial", "overview", "chapter", "volume", "resources", "section", "assessment"]);

export function parseNavigator(input: unknown): NavEntry[] {
  const langs = (input as any)?.interfaceLanguages;
  if (!langs || typeof langs !== "object" || Array.isArray(langs)) throw new Error("not a navigator index (no interfaceLanguages)");
  const byPath = new Map<string, NavEntry>();
  for (const [lang, tree] of Object.entries(langs)) {
    if (Array.isArray(tree)) walk(tree, lang, byPath);
  }
  for (const e of byPath.values()) e.languages.sort((a, b) => (a === "swift" ? -1 : b === "swift" ? 1 : a.localeCompare(b)));
  return [...byPath.values()];
}

function walk(nodes: any[], lang: string, out: Map<string, NavEntry>) {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const path = typeof n.path === "string" ? n.path.toLowerCase() : undefined;
    if (path && n.type !== "groupMarker" && !n.external) {
      let e = out.get(path);
      if (!e) {
        const navType = String(n.type ?? "symbol");
        e = { path, title: String(n.title ?? path), navType, pageKind: pageKindForNavType(navType, path), languages: [], deprecated: n.deprecated === true, beta: n.beta === true };
        out.set(path, e);
      } else {
        e.deprecated ||= n.deprecated === true;
        e.beta ||= n.beta === true;
      }
      if (!e.languages.includes(lang)) e.languages.push(lang);
    }
    if (Array.isArray(n.children)) walk(n.children, lang, out);
  }
}

export function pageKindForNavType(navType: string, path: string): PageKind {
  if (path.startsWith("/tutorials/") || TUTORIAL_TYPES.has(navType)) return "tutorial";
  if (navType === "article") return path.startsWith("/design/") ? "guideline" : "article";
  if (navType === "sampleCode") return "sampleCode";
  if (navType === "collection" || navType === "module" || navType === "collectionGroup") return path.startsWith("/design/") ? "guideline" : "collection";
  return API_LIKE_DEFAULT; // every symbol type: method, property, struct, httpRequest, dictionarySymbol, ...
}

/** Last path segment without DocC disambiguators: "update()-9fxv4" -> "update()", "type-swift.enum" -> "type". */
export function symbolName(path: string): string {
  let s = path.split("/").filter(Boolean).pop() ?? "";
  s = s.replace(/-swift\.[a-z]+$/, "");
  // Overload hash: strip when it follows ")" or contains a digit (article slugs like "-views" must survive).
  const m = s.match(/^(.*?)-([0-9a-z]{4,6})$/);
  if (m && (m[1].endsWith(")") || /\d/.test(m[2]))) s = m[1];
  return s;
}

/** Search words: camelCase and punctuation split, lowercased. "URLSessionDataTask" -> "url session data task". */
export function wordsOf(text: string): string {
  return text
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
