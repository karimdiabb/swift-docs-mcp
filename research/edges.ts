// Phase 1, step 4: edge behaviour (caching headers, redirects, case, 404 shape, localization,
// HTML pages, and discovery routes for collections that have no navigator index).
// Usage: node research/edges.ts
import { probe, json, save, requestCount } from "./http.ts";

const out: Record<string, any> = {};
const keep = (h: Record<string, string>) => {
  const k = ["content-type", "content-length", "content-encoding", "etag", "last-modified", "cache-control", "age", "expires", "vary"];
  return Object.fromEntries(k.filter((x) => h[x]).map((x) => [x, h[x]]));
};
async function record(name: string, path: string, headers: Record<string, string> = {}) {
  const p = await probe(path, headers);
  out[name] = { path, status: p.status, bytes: p.bytes, location: p.location, headers: keep(p.headers) };
  console.log(`${name.padEnd(26)} ${p.status} ${String(p.bytes).padStart(8)} ${path}${p.location ? " -> " + p.location : ""}`);
  return p;
}

// 1. Caching headers + conditional requests (needed for incremental refresh)
const idx = await record("indexHeaders", "/tutorials/data/index/swiftui");
const page = await record("pageHeaders", "/tutorials/data/documentation/swiftui/view.json");
if (idx.headers.etag) await record("indexIfNoneMatch", "/tutorials/data/index/swiftui", { "if-none-match": idx.headers.etag });
if (idx.headers["last-modified"]) await record("indexIfModifiedSince", "/tutorials/data/index/swiftui", { "if-modified-since": idx.headers["last-modified"] });
if (page.headers.etag) await record("pageIfNoneMatch", "/tutorials/data/documentation/swiftui/view.json", { "if-none-match": page.headers.etag });

// 2. Case sensitivity, trailing slash, unknown page
await record("dataMixedCase", "/tutorials/data/documentation/SwiftUI/View.json");
await record("htmlMixedCase", "/documentation/SwiftUI/View");
await record("htmlTrailingSlash", "/documentation/swiftui/view/");
const missing = await record("dataMissing", "/tutorials/data/documentation/swiftui/no-such-page-zzz.json");
out.dataMissing.bodyIsJson = (() => { try { JSON.parse(missing.body); return true; } catch { return false; } })();

// 3. Human HTML page: does it contain the content, or is it a JS shell?
const html = await record("htmlPage", "/documentation/swiftui/view");
out.htmlPage.hasDeclarationText = html.body.includes("protocol View");
out.htmlPage.hasNoscript = html.body.includes("<noscript");
out.htmlPage.scriptTags = (html.body.match(/<script/g) ?? []).length;

// 4. Localization
const ja = await probe("/tutorials/data/documentation/swiftui/view.json", { "accept-language": "ja-JP" });
out.localizationHeader = { status: ja.status, sameBodyAsEnglish: ja.body === page.body };
console.log(`localizationHeader         ${ja.status} same-as-en=${ja.body === page.body}`);

// 5. Discovery routes for things without a per-technology navigator index
for (const [name, path] of Object.entries({
  higIndexDesign: "/tutorials/data/index/design",
  tutorialsIndex: "/tutorials/data/index/tutorials",
  tutorialsCatalogJson: "/tutorials/data/tutorials.json",
  swiftBookData: "/tutorials/data/documentation/the-swift-programming-language.json",
  swiftBookIndex: "/tutorials/data/index/the-swift-programming-language",
  xcodeCloudIndexByParent: "/tutorials/data/index/xcode",
  legacyArchive: "/library/archive/navigation/",
})) {
  const p = await record(name, path);
  if (name === "xcodeCloudIndexByParent" && p.status === 200) out[name].containsXcodeCloud = p.body.includes('"/documentation/xcode/xcode-cloud"');
}

// 6. HIG tree: discover pages by following topicSections from the HIG root (no index exists).
const { data: higRoot } = await json<any>("/tutorials/data/design/human-interface-guidelines.json");
const higTopics = new Set<string>();
for (const s of higRoot?.topicSections ?? []) for (const id of s.identifiers ?? []) {
  const url = higRoot.references?.[id]?.url;
  if (url) higTopics.add(url);
}
out.higRootTopics = { count: higTopics.size, sample: [...higTopics].slice(0, 8) };
console.log(`higRootTopics              ${higTopics.size}`, [...higTopics].slice(0, 5));

out.requests = requestCount;
save("edges.json", out);
