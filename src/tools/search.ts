import type { z } from "zod";
import type { PageKind } from "../apple/types.ts";
import type { SearchHit } from "../index/store.ts";
import { errorResult, NO_INDEX, text, type ToolContext } from "./context.ts";
import type { searchInput } from "./schemas.ts";

export const SEARCH_DESCRIPTION =
  "Search Apple's developer documentation (all frameworks, articles, tutorials, sample code and the Human Interface Guidelines) in a local index built from Apple's own catalog. Returns titles, kinds, frameworks, canonical URLs and, when known, abstracts, declarations and availability. Use get_apple_doc with a result URL for the full page.";

const KIND_LABEL: Record<string, string> = { api: "API reference", article: "Article", tutorial: "Tutorial", sampleCode: "Sample code", guideline: "Human Interface Guidelines", collection: "Collection", other: "Documentation" };

export function searchTool(ctx: ToolContext, a: z.infer<typeof searchInput>) {
  const store = ctx.index();
  if (!store) return NO_INDEX(ctx);
  try {
    const kind = a.kind === "sample_code" ? "sampleCode" : (a.kind as PageKind | undefined);
    const r = store.search(a.query, { limit: a.limit ?? 10, ...(a.cursor ? { cursor: a.cursor } : {}), ...(a.framework ? { framework: a.framework } : {}), ...(a.platform ? { platform: a.platform } : {}), ...(kind ? { kind } : {}) });
    const filters = [a.framework && `framework ${a.framework}`, a.platform && `platform ${a.platform}`, a.kind && `kind ${a.kind}`].filter(Boolean).join(", ");
    const built = store.getMeta("lastRefresh") ?? store.getMeta("lastBuild");
    const head = `Search results for "${a.query}"${filters ? ` (${filters})` : ""}: ${r.hits.length} of ${r.total}.\nSource: local index of Apple's documentation${built ? ` (updated ${new Date(Number(built)).toISOString().slice(0, 10)})` : ""}; not a live Apple search.`;
    const notes: string[] = [];
    if (!r.matchedAllWords) notes.push("No page matched all words; showing pages that match any word.");
    if (a.platform && r.platformUnknown) notes.push(`${r.platformUnknown} matching pages without platform data (not fetched yet) were left out by the platform filter; search without it to see them.`);
    if (!r.hits.length) return text(`${head}\n\nNo results.${notes.length ? "\n\n" + notes.join("\n") : ""}\n\nTry fewer or different words, another framework, or no filters.`);
    const offset = a.cursor ? decodeOffset(a.cursor) : 0;
    const items = r.hits.map((h, i) => hitText(h, offset + i + 1)).join("\n\n");
    const more = r.nextCursor ? `\n\nMore results: call again with cursor: "${r.nextCursor}"` : "";
    return text(`${head}\n\n${items}${more}${notes.length ? "\n\n" + notes.join("\n") : ""}`);
  } catch (e) {
    return errorResult(ctx, "search_apple_docs", e);
  }
}

function hitText(h: SearchHit, n: number): string {
  const flags = [h.deprecated ? "deprecated" : "", h.beta ? "beta" : ""].filter(Boolean);
  const lines = [`${n}. **${h.title}**${flags.length ? ` (${flags.join(", ")})` : ""} — ${KIND_LABEL[h.pageKind] ?? h.pageKind} · ${h.framework}${h.pageKind === "api" ? ` · ${h.navType} \`${h.name}\`` : ""}`, `   ${h.url}`];
  if (h.declaration) lines.push(`   \`${h.declaration.replace(/\s+/g, " ")}\``);
  if (h.abstract) lines.push(`   ${h.abstract}`);
  if (h.platforms?.length) lines.push(`   Availability: ${h.platforms.map((p) => (p.unavailable ? `${p.platform} unavailable` : `${p.platform} ${p.introduced ?? ""}+${p.deprecated ? ` (deprecated ${p.deprecated})` : ""}`)).join(", ")}`);
  return lines.join("\n");
}

function decodeOffset(c: string) {
  const m = Buffer.from(c, "base64url").toString().match(/^o:(\d+)$/);
  return m ? Number(m[1]) : 0;
}
