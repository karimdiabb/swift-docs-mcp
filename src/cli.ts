#!/usr/bin/env node
// Command line for the explicit, non-MCP operations: building/refreshing the index, enrichment, status, cache.
// All output goes to stderr except command results (status, doc), which go to stdout.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AppleClient } from "./apple/client.ts";
import { DocService } from "./apple/docs.ts";
import { appDir, DocCache } from "./cache/cache.ts";
import { Indexer } from "./index/sync.ts";
import { IndexStore } from "./index/store.ts";
import { buildStatus, renderStatus } from "./status.ts";

export const DEFAULT_ENRICH_KINDS = ["struct", "class", "protocol", "enum", "actor", "collection", "article", "sampleCode"];
export const DEFAULT_TUTORIAL_SEEDS = ["/tutorials/swiftui"];
const MIN_INTERVAL_MS = 250;

export type Command =
  | { cmd: "help" }
  | { cmd: "status" }
  | { cmd: "cache-clear" }
  | { cmd: "doc"; url: string; maxRelated: number; objc: boolean }
  | { cmd: "sync"; mode: "build" | "refresh"; only?: string[]; intervalMs: number; maxWalkPages: number }
  | { cmd: "enrich"; kinds: string[]; framework?: string; max: number; intervalMs: number };

export const USAGE = `swift-docs-mcp — local, read-only Apple documentation MCP server

Usage:
  swift-docs-mcp                      start the MCP server on stdio (what Claude Desktop runs)
  swift-docs-mcp index build          discover Apple's documentation and build the local index (~15-25 min)
  swift-docs-mcp index refresh        update the index; unchanged roots cost one 304 request each
  swift-docs-mcp index enrich         fetch abstracts/platforms/declarations for top-level pages
  swift-docs-mcp index status         show coverage, freshness and errors
  swift-docs-mcp cache clear          delete cached pages (the index is kept)
  swift-docs-mcp doc <url>            print one documentation page as Markdown

Options:
  --only a,b          (build/refresh) only these roots, by slug, e.g. swiftui,uikit
  --max-walk N        (build/refresh) max pages per walked root (default 3000)
  --interval-ms N     minimum milliseconds between requests to Apple (default 1000, min ${MIN_INTERVAL_MS})
  --kinds a,b         (enrich) navigator kinds (default ${DEFAULT_ENRICH_KINDS.join(",")})
  --framework f       (enrich) limit to one root slug
  --max N             (enrich) max pages (default 1000)
  --related N         (doc) max items per related group (default 10)
  --objc              (doc) show the Objective-C variant

Data directory: ~/Library/Caches/swift-docs-mcp on macOS (override with SWIFT_DOCS_MCP_HOME).`;

export function parseCli(argv: string[]): Command {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return { cmd: "help" };
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      only: { type: "string" },
      "max-walk": { type: "string" },
      "interval-ms": { type: "string" },
      kinds: { type: "string" },
      framework: { type: "string" },
      max: { type: "string" },
      related: { type: "string" },
      objc: { type: "boolean" },
    },
  });
  const [a, b] = positionals;
  const int = (name: string, v: string | undefined, def: number, min: number) => {
    if (v === undefined) return def;
    if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`--${name} must be an integer >= ${min}`);
    return Number(v);
  };
  const list = (v: string | undefined) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  const intervalMs = int("interval-ms", values["interval-ms"], 1000, MIN_INTERVAL_MS);

  if (a === "index" && (b === "build" || b === "refresh")) {
    const only = list(values.only)?.map((s) => s.toLowerCase());
    return { cmd: "sync", mode: b, ...(only ? { only } : {}), intervalMs, maxWalkPages: int("max-walk", values["max-walk"], 3000, 1) };
  }
  if (a === "index" && b === "enrich") {
    return {
      cmd: "enrich",
      kinds: list(values.kinds) ?? DEFAULT_ENRICH_KINDS,
      ...(values.framework ? { framework: values.framework.toLowerCase() } : {}),
      max: int("max", values.max, 1000, 1),
      intervalMs,
    };
  }
  if (a === "index" && b === "status") return { cmd: "status" };
  if (a === "cache" && b === "clear") return { cmd: "cache-clear" };
  if (a === "doc") {
    if (!b) throw new Error("doc needs a documentation URL");
    return { cmd: "doc", url: b, maxRelated: int("related", values.related, 10, 0), objc: !!values.objc };
  }
  throw new Error(`unknown command: ${positionals.join(" ")}`);
}

export async function runCli(argv: string[]): Promise<number> {
  let c: Command;
  try {
    c = parseCli(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (c.cmd === "help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const dir = appDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cache = new DocCache({ dir });
  const indexFile = join(dir, "index.sqlite");

  if (c.cmd === "cache-clear") {
    process.stdout.write(`removed ${cache.clear()} cached pages from ${cache.stats().dir}\n`);
    return 0;
  }
  if (c.cmd === "status") {
    let store: IndexStore | undefined;
    let storeError: string | undefined;
    try {
      store = IndexStore.open(indexFile, { readOnly: true });
    } catch (e) {
      storeError = (e as Error).message;
    }
    process.stdout.write(renderStatus(buildStatus({ store, ...(storeError ? { storeError } : {}), cache, recentErrors: [] })) + "\n");
    store?.close();
    return 0;
  }
  if (c.cmd === "doc") {
    const docs = new DocService({ client: new AppleClient(), cache });
    const r = await docs.getDoc(c.url, { maxRelated: c.maxRelated, ...(c.objc ? { language: "occ" as const } : {}) });
    process.stdout.write(r.markdown + "\n");
    return 0;
  }

  // build / refresh / enrich: one at a time
  const release = acquireLock(join(dir, "sync.lock"));
  const store = IndexStore.open(indexFile);
  try {
    const client = new AppleClient({ minIntervalMs: c.intervalMs });
    const indexer = new Indexer({ client, docs: new DocService({ client, cache }), store });
    if (c.cmd === "sync") {
      const r = await indexer.sync({ mode: c.mode, maxWalkPages: c.maxWalkPages, ...(c.only ? { only: c.only } : { tutorialSeeds: DEFAULT_TUTORIAL_SEEDS }) });
      process.stderr.write(`\n${r.docs} pages indexed, ${r.removed} removed, ${r.errors.length} errors${r.partial ? " (partial: see `index status`)" : ""}\n`);
      for (const e of r.errors.slice(0, 20)) process.stderr.write(`  - ${e}\n`);
      return r.partial ? 1 : 0;
    }
    const r = await indexer.enrich({ kinds: c.kinds, max: c.max, ...(c.framework ? { framework: c.framework } : {}) });
    process.stderr.write(`enriched ${r.enriched}, failed ${r.failed} (${r.notFound} no longer exist)${r.aborted ? ", aborted" : ""}\n`);
    return r.aborted ? 1 : 0;
  } finally {
    store.close();
    release();
  }
}

/** Exclusive lock file holding our pid. A lock left by a dead process is taken over. */
function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8"));
      if (pid && isAlive(pid)) throw new Error(`another index operation is running (pid ${pid}); lock: ${file}`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not acquire lock ${file}`);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}
