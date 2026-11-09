// Shared state for tool handlers: services, the (optional) index, and a ring buffer of recent errors.
import { existsSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AppleHttpError } from "../apple/client.ts";
import type { DocService } from "../apple/docs.ts";
import type { DocCache } from "../cache/cache.ts";
import { IndexStore, IndexUnavailable } from "../index/store.ts";
import { siteOf, UrlRejected } from "../security/url.ts";

export type ToolContext = {
  docs: DocService;
  cache: DocCache;
  /** Index, if available. Re-opened lazily if it appears later (e.g. after `index build`). */
  index(): IndexStore | undefined;
  indexError(): string | undefined;
  recentErrors: string[];
  recordError(tool: string, e: unknown): void;
  close(): void;
};

export function createContext(o: { docs: DocService; cache: DocCache; indexFile: string; store?: IndexStore }): ToolContext {
  let store = o.store;
  let lastError: string | undefined;
  let lastTry = 0;
  const recentErrors: string[] = [];
  const ctx: ToolContext = {
    docs: o.docs,
    cache: o.cache,
    index() {
      if (store) return store;
      const now = Date.now();
      if (now - lastTry < 5000) return undefined; // don't hit the disk on every call
      lastTry = now;
      if (!existsSync(o.indexFile)) {
        lastError = `no index at ${o.indexFile}`;
        return undefined;
      }
      try {
        store = IndexStore.open(o.indexFile);
        lastError = undefined;
      } catch (e) {
        lastError = e instanceof IndexUnavailable ? e.message : String(e);
      }
      return store;
    },
    indexError: () => lastError ?? (store ? undefined : `no index at ${o.indexFile}`),
    recentErrors,
    recordError(tool, e) {
      recentErrors.push(`${new Date().toISOString()} ${tool}: ${(e as Error)?.message ?? String(e)}`);
      if (recentErrors.length > 50) recentErrors.shift();
    },
    close() {
      store?.close();
      store = undefined;
    },
  };
  return ctx;
}

export const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export const NO_INDEX = (ctx: ToolContext) =>
  text(
    `The local search index is not available (${ctx.indexError()}).\n\nBuild it once with \`swift-docs-mcp index build\` (or \`npm run index:build\` in the project folder); it takes about 15-25 minutes.\nUntil then, get_apple_doc still works with a full https://developer.apple.com/documentation/... URL.`,
    true,
  );

/** Turn a failure into a clear, honest tool error. */
export function errorResult(ctx: ToolContext, tool: string, e: unknown, url?: string): CallToolResult {
  ctx.recordError(tool, e);
  if (e instanceof UrlRejected)
    return text(`URL rejected (${e.reason}). Supported pages: https://developer.apple.com/documentation/..., /design/human-interface-guidelines/..., /tutorials/..., and https://docs.swift.org/latest/documentation/... .`, true);
  if (e instanceof AppleHttpError) {
    const site = siteOf(e.url).name;
    if (e.kind === "not_found") return text(`${site} returned 404 (not found) for ${url ?? e.url}. The page may not exist or may have moved; try search_apple_docs.`, true);
    if (e.kind === "network" || e.kind === "timeout" || e.kind === "http")
      return text(`${site} could not be reached (${e.kind}${e.status ? ` ${e.status}` : ""}) and no cached copy is available for ${url ?? e.url}. Nothing was retrieved.`, true);
    if (e.kind === "blocked") return text(`Request blocked by the server's security rules: ${e.message}`, true);
    return text(`${site} returned an unexpected response (${e.kind}): ${e.message}. Nothing was retrieved.`, true);
  }
  return text(`Internal error in ${tool}: ${(e as Error)?.message ?? String(e)}`, true);
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const PLATFORM_NAMES = ["iOS", "iPadOS", "macOS", "watchOS", "tvOS", "visionOS", "Mac Catalyst"] as const;
