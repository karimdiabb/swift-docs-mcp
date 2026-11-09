import type { z } from "zod";
import { fence } from "../apple/docc-parser.ts";
import type { IndexDoc } from "../index/store.ts";
import { lazyEnrich, DATA_NOTE } from "./documentation.ts";
import { errorResult, NO_INDEX, text, type ToolContext } from "./context.ts";
import type { apiInput } from "./schemas.ts";

const ORIGIN = "https://developer.apple.com";
const MAX_CANDIDATES = 25;

export const API_DESCRIPTION =
  "Get focused details for one API symbol: exact declaration(s), symbol kind, parameters, return value, availability and deprecation, parent type and related symbols, with the canonical URL. Accepts names like NavigationStack, View.onAppear, SwiftUI.View or a full signature like frame(width:height:alignment:). If several symbols match, it lists the candidates instead of guessing.";

export async function apiTool(ctx: ToolContext, a: z.infer<typeof apiInput>) {
  const store = ctx.index();
  if (!store) return NO_INDEX(ctx);
  try {
    let candidates = store.findSymbol(a.symbol, a.framework ? { framework: a.framework } : {});
    let platformNote = "";
    if (a.platform) {
      const known = candidates.filter((c) => c.platforms);
      const onPlatform = (c: IndexDoc) => c.platforms!.some((p) => p.platform === a.platform && !p.unavailable);
      const dropped = known.filter((c) => !onPlatform(c)).length;
      candidates = candidates.filter((c) => !c.platforms || onPlatform(c));
      if (dropped) platformNote = `\n\n${dropped} matching symbols are not available on ${a.platform} and were left out.`;
    }

    if (!candidates.length) {
      const sug = store.search(a.symbol, { limit: 5, kind: "api", ...(a.framework ? { framework: a.framework } : {}) }).hits;
      return text(`No API symbol named "${a.symbol}"${a.framework ? ` in ${a.framework}` : ""} was found in the index.${platformNote}${sug.length ? `\n\nClosest search results:\n${sug.map((h) => `- ${h.title} — ${h.framework}: ${h.url}`).join("\n")}` : ""}\n\nTry search_apple_docs for broader matches.`);
    }
    if (candidates.length > 1) {
      const list = candidates.slice(0, MAX_CANDIDATES).map((c) => `- \`${c.name}\` — ${c.navType} in ${c.root.split("/").pop()} — ${ORIGIN + c.path}${c.declaration ? `\n  \`${c.declaration.replace(/\s+/g, " ")}\`` : `\n  ${c.title}`}`);
      return text(
        `Ambiguous: ${candidates.length} symbols match "${a.symbol}". Not choosing one.${platformNote}\n\n${list.join("\n")}${candidates.length > MAX_CANDIDATES ? `\n- …and ${candidates.length - MAX_CANDIDATES} more` : ""}\n\nNarrow it with the framework, a parent type (Type.member), or the full signature such as ${candidates[0].name.includes("(") ? candidates[0].name : `${candidates[0].name}(…)`}, or call get_apple_doc with one of the URLs.`,
      );
    }

    const c = candidates[0];
    const r = await ctx.docs.getDoc(ORIGIN + c.path, { includeRelated: true, maxRelated: 10 });
    lazyEnrich(ctx, r.page);
    const p = r.page;
    const parentPath = c.path.split("/").slice(0, -1).join("/");
    const parent = parentPath.split("/").length > 2 ? store.get(parentPath) : undefined;
    const out = [`# ${p.title}`, `Symbol kind: ${p.roleHeading ?? p.symbolKind ?? c.navType}${p.symbolKind ? ` (${p.symbolKind})` : ""} · ${p.framework ?? c.root}`, `URL: ${p.url}`];
    if (parentPath.split("/").length > 2) out.push(`Parent: ${parent ? `${parent.title} — ` : ""}${ORIGIN + parentPath}`);
    if (p.deprecated) out.push(`> **Deprecated.**${p.deprecationSummary ? " " + p.deprecationSummary : ""}`);
    if (p.abstract) out.push(p.abstract);
    out.push(p.declarations.length ? `## Declaration\n\n${p.declarations.map((d) => fence(d.languages[0] ?? p.language, d.code)).join("\n\n")}` : "## Declaration\n\nApple's page has no declaration for this symbol.");
    if (p.parameters.length) out.push(`## Parameters\n\n${p.parameters.map((x) => `- \`${x.name}\`: ${x.markdown.replace(/\n+/g, " ")}`).join("\n")}`);
    const ret = p.body.match(/^## Return Value\n\n([\s\S]*?)(?=\n#{2,3} |$)/m);
    if (ret) out.push(`## Return Value\n\n${ret[1].trim()}`);
    if (p.availability.length)
      out.push(`## Availability\n\n${p.availability.map((x) => (x.unavailable ? `- ${x.platform}: unavailable` : `- ${x.platform} ${x.introduced ?? ""}+${x.beta ? " (beta)" : ""}${x.deprecated ? ` — deprecated ${x.deprecated}` : x.deprecatedNoVersion ? " — deprecated" : ""}`)).join("\n")}`);
    const related = [...p.relationships, ...p.topics, ...p.seeAlso].flatMap((g) => g.items.map((i) => ({ ...i, group: g.title }))).slice(0, 12);
    if (related.length) out.push(`## Related symbols\n\n${related.map((i) => `- ${i.title}${i.url ? ` — ${i.url}` : ""} (${i.group})`).join("\n")}`);
    out.push(`---\nRetrieved ${new Date(r.fetchedAt).toISOString()} from Apple (${r.fromCache ? "from local cache" : "not cached"}).${platformNote}`);
    return text(`${r.warning ? `> **Warning:** ${r.warning}\n\n` : ""}${DATA_NOTE}\n\n${out.join("\n\n")}`);
  } catch (e) {
    return errorResult(ctx, "get_apple_api_details", e);
  }
}
