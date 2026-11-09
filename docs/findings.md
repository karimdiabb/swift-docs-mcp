# Phase 1 findings: Apple documentation discovery and retrieval

Date: 2026-11-09. Every number below comes from the scripts in `research/` (`discovery.ts`, `pages.ts`,
`edges.ts`) and can be reproduced by running them again. All requests were sequential at 1 req/s with a named
User-Agent, and never touched robots-disallowed paths.

## Endpoint status
Apple publishes **no documentation** for any of these endpoints. All are *observed*. The JSON formats come from
Apple's open-source DocC (`swift-docc`): page JSON = "RenderNode", navigator = "RenderIndex". swift-docc ships
specs for both. That makes the format stable-ish, but the hosting could still change. The server must treat
schema changes as errors it reports, never as silent empty results.

| Purpose | Endpoint (all on `https://developer.apple.com`) | Status | Notes |
|---|---|---|---|
| Root catalog | `/tutorials/data/documentation/technologies.json` | observed | 403 topic refs: 398 collections + 5 collection groups. One under `/design`, the rest under `/documentation` |
| Per-technology enumerator | `/tutorials/data/index/<slug>` | observed | Navigator tree (`swift` + `occ`). 397/403 exist |
| Page JSON (docs) | `/tutorials/data/documentation/<path>.json` | observed | Every page kind tested returns 200 |
| Page JSON (HIG) | `/tutorials/data/design/human-interface-guidelines/<path>.json` | observed | |
| Page JSON (tutorials) | `/tutorials/data/tutorials/<path>.json` | observed | `kind: project` / `overview` |
| Human page | `/documentation/<path>`, `/design/...`, `/tutorials/...` | observed | JavaScript shell with no content (see HTML) |
| Search | `/search/` | **robots-disallowed** | Not used. Search must run on a local index |

## Corpus size (full sweep, `discovery.ts --all`)
- 403 technologies. 397 have navigator indexes, 138 MB in total (the index responses were not gzip-encoded).
- **383,994 unique internal paths** after dropping `external` nodes and `groupMarker`s and deduplicating.
- Largest kinds: property 87k, case 78k, method 76k, func 24k, var 23k, init 20k, struct 10k, typealias 9.7k,
  class 8.9k, enum 8.6k, dictionarySymbol 8.5k, macro 7.1k, collection 6.6k, article 3.5k, protocol 2.7k,
  httpRequest 2.1k, sampleCode 656.
- The largest indexes are not the expected ones: Matter (10.8 MB), Kernel (9.7 MB), Accelerate (6.7 MB),
  Foundation (6.7 MB).
- **6 technologies have no index:** HIG plus 5 nested collections (`accelerate/simd-library`,
  `safariservices/safari-app-extensions`, `uikit/mac-catalyst`, `xcode/xcode-cloud`, `xcode/swift-packages`).
  Their page JSON exists (200), but the parent index doesn't list them (checked for `xcode-cloud`).
- Navigator nodes only have `title, type, path, deprecated, beta, external`. There are **no abstracts,
  platforms or declarations**, which live only in the page JSON.

## Page JSON (`pages.ts`, 22 page kinds)
- URL mapping: `/x/y` → `/tutorials/data/x/y.json`. It is **case-insensitive** (mixed case returns the same
  200), so the lowercase path is the canonical key. It works for overload hashes (`update()-9fxv4`), operators
  (`+(_:_:)`), ObjC selectors (`decimalnumberwithdecimal:`) and disambiguators (`type-swift.enum`).
- `schemaVersion` was 0.3.0 on every page sampled.
- Where things live:
  - Declarations: `primaryContentSections[kind=declarations].declarations[].tokens[]` (kinds: keyword,
    identifier, typeIdentifier, genericParameter, attribute, text). Joining `text` gives the exact declaration,
    e.g. `nonisolated struct NavigationStack<Data, Root> where Root : View`.
  - Parameters: a `primaryContentSections[kind=parameters]` section. Returns and discussion are in
    `kind=content`, as headings followed by blocks.
  - Availability: `metadata.platforms[] {name, introducedAt, deprecatedAt, beta}`. Deprecation also appears in
    `deprecationSummary`.
  - Navigation: `topicSections`, `relationshipsSections` (conformsTo, inheritedBy, conformingTypes),
    `seeAlsoSections` and `hierarchy`. Every link is a `doc://` id resolved through `references`.
- **Objective-C** is not a separate page. `variantOverrides` holds JSON Patch (RFC 6902) operations that turn
  the Swift view into the ObjC view (declaration, platforms, title). ObjC-only symbols come in plain `occ` form.
- Content block types seen: paragraph, heading, codeListing, aside, orderedList/unorderedList, table,
  termList, tabNavigator, emphasis/strong. Inline types seen: text, codeVoice, reference, image, video, links.
  Unknown types must be kept, not dropped.
- Tutorials are a different shape: `kind=project` with `sections: hero, tasks (steps), assessments,
  callToAction`, plus `file` references for code. They need their own renderer.

## Edge behaviour (`edges.ts`)
- **Incremental refresh works:** indexes and pages send `ETag` and `Last-Modified`. `If-None-Match` and
  `If-Modified-Since` both return **304** with an empty body. `cache-control: max-age=300`.
- 404 returns an **HTML** body (`text/html`), so the client must check status and content type before parsing.
- No redirects for mixed case or trailing slashes (both return 200).
- `Accept-Language: ja-JP` returns the same English JSON. Localization is out of scope.
- **The HTML pages are JavaScript shells:** no declaration text, just `<noscript>` and 5 script tags. An HTML
  fallback would get nothing useful from DocC pages.
- Hosts referenced from pages: content is all on `developer.apple.com`. Images are mostly relative `/images/`,
  with a few on `devimages-cdn.apple.com`. Images and videos are returned as links and never fetched.

## Coverage gaps
| Area | Status | Plan |
|---|---|---|
| 397 framework/collection indexes | Enumerated | Main discovery source |
| HIG + 5 nested collections | No index | Walk `topicSections` from their root pages (bounded) |
| Tutorials | No catalog endpoint | Seed from `/tutorials/...` references found while walking pages, plus a configurable seed list. Reported as partial |
| Swift book (*The Swift Programming Language*) | Hosted on `docs.swift.org`, not Apple's developer site. Blocked by this sandbox's firewall | **Open question** |
| Legacy Documentation Archive (`/library/archive`) | Static HTML only. Retired by Apple | Excluded |
| Abstracts / platforms / declarations for all 384k pages | Not in the indexes | Lazy (filled in when a page is fetched) + optional enrichment crawl |
| Localized docs | Not served via JSON | Excluded (English only) |

## Proposed architecture
1. **Discovery (CLI `index build`)**: technologies.json → 397 navigator indexes → tree-walk for the 6 roots
   without one and for tutorial roots. Each entry gets: canonical path, title, kind, framework, languages
   (swift/occ), deprecated, beta, source root. Store the `ETag` of each index.
2. **Refresh (CLI `index refresh`)**: conditional GET for each index. A 304 means nothing to do. A 200 means
   diff the path sets: add new paths, mark missing ones `removed`. The whole refresh costs about 400 cheap
   requests.
3. **Search**: SQLite FTS5 over title/path/abstract, ranked by bm25 plus boosts for exact title matches and
   top-level kinds. Filtering on `framework` and `kind` always works. Filtering on `platform` only works for
   entries whose page JSON has been fetched, and the status tool reports how many that is.
4. **Retrieval**: fetch page JSON → cache (7-day TTL, revalidated with ETag/304) → render to Markdown.
   Abstract, platforms and declaration get written back into the index (lazy enrichment).
5. **Optional enrichment (CLI `index enrich --kinds ... --max N`)**: fetch page JSON in the background for a
   budget of pages. Top-level kinds (struct, class, protocol, enum, collection, article, sampleCode) are about
   41k pages, roughly 11.4 hours at 1 req/s. All 384k pages would be about 4.4 days and about 6 GB, so that is not
   the default.
6. **Security allowlist**: the single host `developer.apple.com`. Fetchable path prefixes are `/tutorials/data/`
   only. Accepted input URLs are `/documentation/`, `/design/human-interface-guidelines/`, `/tutorials/` (mapped
   to their data path).

## Library recommendations (need your approval)
- **Index: `node:sqlite` (built in, no dependency).** Tested: FTS5 + `bm25()` work (SQLite 3.53.4). At 384k
  entries, an on-disk index keeps memory small and starts fast. MiniSearch would have to load the whole corpus
  into memory each time Claude Desktop starts the server. Risk: `node:sqlite` is marked experimental in Node 22
  and prints a warning to stderr (allowed, since stdout stays protocol-only). If its API changes, better-sqlite3
  is a drop-in fallback but needs a native build.
- **HTML parser: none.** DocC HTML pages are JS shells and the legacy archive is excluded, so the HTML fallback
  is dropped. The spec allows this ("only if necessary").
