# swift-docs-mcp

A local, read-only [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Desktop
search and retrieval over **Apple's developer documentation** (every framework in Apple's catalog, plus
articles, sample code, tutorials and the Human Interface Guidelines) and **swift.org's documentation**
(*The Swift Programming Language*, API Design Guidelines, SwiftPM, DocC, the Swift 6 migration guide, ...).

It is a documentation retrieval system, not an agent. It finds pages and returns their content faithfully
(exact declarations, availability, deprecation, code listings), always with the source URL.

> [!IMPORTANT]
> **Unofficial project.** Not affiliated with, endorsed by, or supported by Apple Inc. or the Swift project.
> Apple, Swift, Xcode, SwiftUI and other names are trademarks of Apple Inc. All documentation content belongs to
> its owners (Apple Inc., the Swift project). This tool fetches it on your machine for your own use. It does not
> host or redistribute it.

> [!WARNING]
> - **Undocumented endpoints.** It reads the JSON that Apple's and swift.org's documentation websites use
>   internally. These are not public APIs and can change or disappear without notice; if that happens, the
>   server reports errors (it never makes up content) until the code is updated.
> - **Be polite to Apple's servers.** Requests are limited to 1 per second and honour robots.txt. Please don't
>   lower `--interval-ms` much, run builds in parallel, or use this for bulk mirroring.
> - **First build is slow and large:** about 20 minutes and about 300 MB on disk (`~/Library/Caches/swift-docs-mcp`).
> - **Early software (v0.1).** It has a large test suite and runs against the live sites, but it has only been
>   used by its author. Expect rough edges.

## Quick start (macOS)

Requires **Node.js 22.18+** (`node --version`) and Claude Desktop.

```bash
git clone https://github.com/karimdiabb/swift-docs-mcp.git
cd swift-docs-mcp
npm install && npm run build      # build only; Claude Desktop starts the server itself
node dist/index.js index build    # one-time, about 20 min
which node                        # note this path for the config below
```

Then add it to Claude Desktop (**Settings → Developer → Edit Config**), using your own paths:

```json
{
  "mcpServers": {
    "swift-docs": {
      "command": "/ABSOLUTE/PATH/FROM/which/node",
      "args": ["/ABSOLUTE/PATH/TO/swift-docs-mcp/dist/index.js"]
    }
  }
}
```

Quit Claude Desktop with ⌘Q, reopen it, and ask something like *"Use swift-docs: what's the declaration of
NavigationStack?"*. If macOS asks whether **node** may access a folder (for example because you cloned into
`~/Desktop` or `~/Documents`), click **Allow**: node needs to read the server's own files. Details are in
sections 7 and 12.

## 1. Purpose and scope

- **Search** a local index of about 380,000 Apple documentation pages built from Apple's own catalog.
- **Retrieve** any page live from Apple as structured Markdown, cached locally for 7 days.
- **Look up one API symbol** and get its declaration(s), parameters, availability and parent. If the name is
  ambiguous, you get the candidates instead of a guess.
- **Report coverage honestly**: what is indexed, how fresh it is, and what is not covered.

Out of scope: AI summaries in place of source text, editing code, reading your projects, Xcode automation,
hosted services, accounts, telemetry.

## 2. Architecture

```
Claude Desktop ──stdio──▶ dist/index.js (MCP server, 4 read-only tools)
                              │
           ┌──────────────────┼────────────────────┐
           ▼                  ▼                    ▼
   local index (SQLite   page retrieval        status report
   FTS5, node:sqlite)    DocService
           ▲                  │ cache (7 days, ETag revalidation, atomic files)
           │                  ▼
   index build/refresh   AppleClient: HTTPS only, developer.apple.com only, /tutorials/data/ only,
   (CLI, explicit)       1 request/s, timeouts, size cap, every redirect re-checked
```

| Path | Role |
|---|---|
| `src/security/url.ts` | URL canonicalization and the host/path allowlist |
| `src/apple/client.ts` | Paced, locked-down HTTP client with conditional requests |
| `src/apple/docc-parser.ts`, `markdown.ts` | DocC JSON → page model → Markdown (incl. Objective-C variants, REST, tutorials) |
| `src/apple/docs.ts` | Retrieval: cache → Apple (304 revalidation) → parse |
| `src/cache/cache.ts` | On-disk page cache |
| `src/index/` | Navigator parser, SQLite store, build/refresh/enrich |
| `src/tools/`, `src/server.ts` | MCP tools and stdio server |
| `src/cli.ts` | `index build/refresh/enrich/status`, `cache clear`, `doc` |


## 3. Documentation coverage and known gaps

**Covered:** every root listed in Apple's catalog (`technologies.json`, about 400 frameworks and collections),
through their navigator indexes. This includes API reference for all symbol kinds (Swift and Objective-C,
REST endpoints, JSON objects, property-list keys), articles, sample-code pages and collections. The Human
Interface Guidelines and a few nested collections without an index are covered by walking their page links.
Tutorial collections are discovered through links (plus a seed, `/tutorials/swiftui`).
From **docs.swift.org**, every collection in its navigator index is included (the Swift book, API Guidelines,
Package Manager, DocC, Embedded Swift, platform guides, compiler diagnostics, the Swift 6 migration guide, ...),
except those Apple's catalog already has (Standard Library, Testing): Apple's copies are used for those.

**Known gaps** (also reported by `get_apple_docs_status`):

- Apple publishes no verified, complete inventory of its documentation, so coverage is "everything Apple's
  own catalog and indexes list", not a proven 100%.
- Abstracts, platforms and declarations are only stored for pages fetched at least once (on demand, or with
  `index enrich`). Until then, search shows title, kind and framework. The `platform` filter drops pages known
  not to support the platform, lists confirmed pages first, and marks the rest "availability not yet known".
- Tutorials have no catalog endpoint; only linked or seeded tutorial collections are found.
- Not included: the retired Documentation Archive (`/library/archive`), localized docs, WWDC videos, forums.
- Sample-code download links aren't generated (the download host is unverified); the sample's page is linked.

## 4. Apple sources and discovery method

Requests go to exactly two hosts:

| Host | Endpoint | Use | Status |
|---|---|---|---|
| developer.apple.com | `/tutorials/data/documentation/technologies.json` | Root catalog | observed, undocumented |
| developer.apple.com | `/tutorials/data/index/<root>` | Navigator index: every page of a root | observed, undocumented |
| developer.apple.com | `/tutorials/data/<page path>.json` | DocC JSON of one page | observed, undocumented |
| docs.swift.org | `/latest/index/index.json` | Navigator for all swift.org collections | observed, undocumented |
| docs.swift.org | `/latest/data/<page path>.json` | DocC JSON of one page | observed, undocumented |

docs.swift.org has no robots.txt; `/swift-book/...` URLs redirect to `/latest/...` and are accepted as aliases.

Apple's search (`/search/`) is **disallowed by robots.txt** and is not used; search runs on the local index.
Requests honour robots.txt, are spaced at least 1 second apart, and identify themselves with a clear
User-Agent. DocC's JSON formats come from Apple's open-source swift-docc. Apple's hosting of them is not
a public API and could change; the server reports such failures as errors, never as empty results.

## 5. Requirements

- macOS (any recent version) with Claude Desktop.
- **Node.js 22.18 or newer** (`node --version`). It uses the built-in `node:sqlite`; nothing else is native.
- About 400 MB of disk for the index and cache, and network access to `developer.apple.com`.

## 6. Installation and build

```bash
cd /path/to/swift-docs-mcp
npm install
npm run build          # compiles to dist/ (it only builds; Claude Desktop starts the server itself)
npm test               # optional: unit tests, no network
```

## 7. Claude Desktop configuration

1. Find the absolute paths you need:
   ```bash
   which node                       # YOUR node path; it differs per Mac (Homebrew, nvm, nodejs.org installer)
   echo "$PWD/dist/index.js"        # run inside the project folder
   ```
2. Open the config file. In Claude Desktop: **Settings → Developer → Edit Config**. On macOS it is currently
   `~/Library/Application Support/Claude/claude_desktop_config.json` (the location may change between
   Claude Desktop versions; use the menu if in doubt):
   ```bash
   open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```
3. Add the server (merge with any existing `mcpServers`):
   ```json
   {
     "mcpServers": {
       "swift-docs": {
         "command": "/ABSOLUTE/PATH/FROM/which/node",
         "args": ["/ABSOLUTE/PATH/TO/swift-docs-mcp/dist/index.js"]
       }
     }
   }
   ```
   Check it starts: `"$(which node)" dist/index.js` should print `swift-docs-mcp 0.1.0 ready` and then wait
   (it expects Claude to talk to it); stop it with Ctrl-C.
4. Quit Claude Desktop completely (⌘Q) and reopen it. The four tools appear under the tools (🔨) menu.
5. Build the index (section 9). Retrieval by URL works before that; search needs the index.

## 8. MCP tools

| Tool | Inputs | Returns |
|---|---|---|
| `search_apple_docs` | `query`; optional `framework`, `platform` (iOS, iPadOS, macOS, watchOS, tvOS, visionOS, Mac Catalyst), `kind` (api, article, tutorial, sample_code, guideline, collection, other), `limit` (≤30), `cursor` | Ranked results: title, kind, framework, symbol name, URL, and abstract/declaration/availability when known |
| `get_apple_doc` | `url`; optional `include_related` (default true), `max_related` (default 10, ≤30) | The full page as Markdown, with source URL, retrieval time and cache status |
| `get_apple_api_details` | `symbol`; optional `framework`, `platform` | Declaration(s), kind, parameters, return value, availability, deprecation, parent, related symbols, URL; or a candidate list if ambiguous |
| `get_apple_docs_status` | none | Sources, search mode, index freshness and counts, frameworks/platforms, cache, known gaps, recent errors |

Example calls (what Claude sends):

```json
{"name": "search_apple_docs", "arguments": {"query": "navigation stack", "framework": "SwiftUI"}}
{"name": "get_apple_doc", "arguments": {"url": "https://developer.apple.com/documentation/swiftui/navigationstack"}}
{"name": "get_apple_doc", "arguments": {"url": "https://developer.apple.com/documentation/foundation/nsstring?language=objc"}}
{"name": "get_apple_doc", "arguments": {"url": "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency"}}
{"name": "get_apple_api_details", "arguments": {"symbol": "View.onAppear"}}
{"name": "get_apple_api_details", "arguments": {"symbol": "frame(width:height:alignment:)"}}
{"name": "get_apple_docs_status", "arguments": {}}
```

## 9. Initial index creation

Building is a deliberate step. The server never crawls on startup.

```bash
node dist/index.js index build        # about 15-25 minutes at 1 request/second
node dist/index.js index status       # check what was indexed
```

It reads Apple's catalog, downloads about 400 navigator indexes (about 140 MB, not kept), walks the roots
that have no index, and writes `index.sqlite`. If it is interrupted, run it again: the status will say
the last sync was interrupted.

## 10. Index refresh, enrichment and cache clearing

```bash
node dist/index.js index refresh                     # conditional requests: unchanged roots cost one 304 each
node dist/index.js index refresh --only swiftui,uikit
node dist/index.js index refresh --only swift.org    # just docs.swift.org
node dist/index.js index enrich                      # fill abstracts/platforms/declarations for top-level
                                                     # pages (struct, class, protocol, enum, article, ...)
node dist/index.js index enrich --framework swiftui --max 500
node dist/index.js cache clear                       # delete cached pages (the index is kept)
node dist/index.js doc https://developer.apple.com/documentation/swiftui/view   # print one page
```

Data lives in `~/Library/Caches/swift-docs-mcp/` (`index.sqlite`, `pages/`). Set `SWIFT_DOCS_MCP_HOME` to use
another absolute path. A refresh never deletes pages because of a failed request. A root whose new index
would remove more than half of its pages is refused and flagged as `partial`. Pages that disappear are kept
as "removed" and come back if Apple lists them again. Run `index refresh` weekly or so; pages fetched through
the tools revalidate themselves after 7 days.

`enrich` is optional. Top-level kinds are about 41,000 pages, roughly 11 hours at 1 request/second. You can
run it in chunks with `--max`, and it skips pages already done.

## 11. Security model and permissions

- **Read-only and narrow.** No shell commands, no reading of arbitrary files or projects, no writes except
  its own data directory, no network port (stdio only), no credentials, and the only environment variables
  it reads are `SWIFT_DOCS_MCP_HOME` and `XDG_CACHE_HOME`.
- **No arbitrary URLs.** Inputs must be `https://developer.apple.com` documentation, HIG or tutorial pages, or
  `https://docs.swift.org/latest/documentation/...` pages.
  The raw input is checked before URL parsing (dot segments, encoded slashes and backslashes, control
  characters). The host must match exactly, so lookalikes, IP literals, subdomains, credentials and ports
  are rejected. Requests can only go to `/tutorials/data/` on Apple's host and `/latest/data/` or `/latest/index/`
  on docs.swift.org, and robots-disallowed paths are refused.
- **Redirects** are followed manually (at most 3) and every hop is re-validated.
- **Limits:** 20-second timeout, 25 MB response cap enforced while streaming, at least 1 second between
  requests, identical in-flight requests shared.
- **Input validation:** every tool argument is validated with strict Zod schemas (unknown keys rejected).
- **Content as data:** retrieved pages are marked as reference content, not instructions. Images and videos
  are links only; nothing downloaded is executed.
- **Logs** go to stderr only; stdout carries only MCP messages (checked by a test that launches the server).

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| Tools don't appear in Claude Desktop | Check the JSON is valid, the paths are absolute, then fully quit (⌘Q) and reopen. Logs: `~/Library/Logs/Claude/mcp*.log`. |
| "spawn node ENOENT" or "No executable file at …" | The `command` path is wrong for your Mac: put the output of `which node` there. |
| Search says the index is not available | Run `node dist/index.js index build`. The server picks up the new index without a restart. |
| "Apple could not be reached" | Network or Apple outage. Cached pages are still served, with a warning and their date. |
| `index build` says another operation is running | Another build/refresh is running. If none is, the lock is from a crashed run and the next run takes it over. |
| Status shows roots with `error`/`partial` | Run `index refresh` later; errors are per root and don't affect the rest. |
| `ExperimentalWarning: SQLite is an experimental feature` | Harmless (stderr). `node:sqlite` is marked experimental in Node 22. |
| "Server disconnected" after a macOS "node would like to access…" popup you denied | System Settings → Privacy & Security → Files & Folders → enable the folder for **node** (or Claude). If it isn't listed: `tccutil reset SystemPolicyDesktopFolder` (or `…DocumentsFolder`), restart Claude and click Allow. Or clone outside protected folders, e.g. `~/Developer`. |
| Results look stale | `node dist/index.js index refresh`; for one page, `cache clear` or wait for the 7-day revalidation. |

## 13. Limitations and endpoint stability

- The JSON endpoints are what Apple's documentation website uses internally. They are stable in practice
  (DocC format), but undocumented: Apple can change them without notice. If that happens, errors appear in
  `get_apple_docs_status` and `index status`, and the parser and discovery code need updating.
- Ranking is local full-text ranking (bm25 with boosts for exact symbol names and top-level types). It is not
  Apple's ranking.
- Coverage limits are listed in section 3.

## Test fixtures

`tests/fixtures/` contains a small number of real documentation pages (DocC JSON) downloaded from
developer.apple.com and docs.swift.org on 2026-11-09. They exist only so the parser can be tested against the
real format offline. Their content belongs to Apple Inc. and the Swift project, and they are not covered by
anything in this repository. If you are a rights holder and want them removed, please open an issue.

## License

[MIT](LICENSE): use, copy, modify and share the code freely. This covers the project's own code only, not the
Apple and swift.org content in `tests/fixtures/` (see above).

## Development

```bash
npm test                      # unit tests (mocked HTTP, no network)
npm run typecheck
npm run test:integration      # opt-in: real Apple pages across ~20 framework families, a small real index,
                              # and the built server over stdio (run `npm run build` first)
npm run doc -- <url>          # render one page from source (no build needed)
```
