// DocC RenderNode JSON -> DocPage.
// Shapes were taken from real Apple pages (see README section 4 and tests/fixtures).
// Rules: exact declarations (tokens joined, never reformatted); unknown types keep their text and are
// recorded in `unsupported`; nothing is invented when a field is missing.
import { linkBase } from "../security/url.ts";
import { AppleHttpError } from "./client.ts";
import type { Availability, Declaration, DocPage, LinkGroup, LinkItem, PageKind, Parameter } from "./types.ts";


type Json = any; // external input: every access below is defensive
type Ctx = { refs: Record<string, Json>; unsupported: string[]; base: string };

export type ParseOptions = { url: string; language?: "swift" | "occ" };

export function parseRenderNode(input: unknown, opts: ParseOptions): DocPage {
  if (!isRenderNode(input)) throw new AppleHttpError("bad_response", opts.url, "not a DocC RenderNode");
  const base: Json = input;
  const baseLang: string = base.identifier.interfaceLanguage ?? "swift";
  const availableLanguages = languagesOf(base, baseLang);
  const want = opts.language;
  const json: Json = want && want !== baseLang && availableLanguages.includes(want) ? applyVariantOverrides(base, want) : base;

  const ctx: Ctx = { refs: isObj(json.references) ? json.references : {}, unsupported: [], base: linkBase(opts.url) };
  const m: Json = isObj(json.metadata) ? json.metadata : {};
  const url = opts.url;

  const declarations: Declaration[] = [];
  const parameters: Parameter[] = [];
  const body: string[] = [];
  const tail: string[] = [];
  for (const s of arr(json.primaryContentSections)) {
    if (!isObj(s)) continue;
    switch (s.kind) {
      case "declarations":
        for (const d of arr(s.declarations)) declarations.push({ code: tokens(d?.tokens), languages: arr(d?.languages).map(String), platforms: arr(d?.platforms).map(String) });
        break;
      case "parameters":
        for (const p of arr(s.parameters)) parameters.push({ name: String(p?.name ?? ""), markdown: blocks(p?.content, ctx) });
        break;
      case "mentions":
        tail.push(section("Mentioned in", linkList(arr(s.mentions), ctx)));
        break;
      default:
        body.push(primarySection(s, ctx));
    }
  }

  const isTutorial = json.kind === "project" || json.kind === "overview";
  for (const s of arr(json.sections)) if (isObj(s)) body.push(isTutorial ? tutorialSection(s, ctx) : genericSection(s, ctx, "section"));

  const availability = arr(m.platforms).filter(isObj).map(availabilityOf);
  const deprecationSummary = json.deprecationSummary ? blocks(json.deprecationSummary, ctx) : undefined;
  const deprecated = !!deprecationSummary || availability.some((a) => a.deprecated || a.deprecatedNoVersion) || m.deprecated === true;

  const page: DocPage = {
    url,
    identifier: String(json.identifier.url),
    language: String(json.identifier.interfaceLanguage ?? baseLang),
    availableLanguages,
    pageKind: pageKindOf(json, m, url),
    title: String(m.title ?? ""),
    abstract: inline(json.abstract, ctx),
    declarations,
    parameters,
    availability,
    deprecated,
    body: [...body, ...tail].filter(Boolean).join("\n\n"),
    topics: groups(json.topicSections, ctx),
    relationships: groups(json.relationshipsSections, ctx),
    seeAlso: groups(json.seeAlsoSections, ctx),
    unsupported: ctx.unsupported,
  };
  if (m.role) page.role = String(m.role);
  if (m.roleHeading) page.roleHeading = String(m.roleHeading);
  if (m.symbolKind) page.symbolKind = String(m.symbolKind);
  const framework = arr(m.modules)[0]?.name;
  if (framework) page.framework = String(framework);
  if (deprecationSummary) page.deprecationSummary = deprecationSummary;
  const dl = json.sampleCodeDownload?.action?.identifier ?? heroOf(json)?.projectFiles;
  if (typeof dl === "string") page.downloadId = ctx.refs[dl]?.url ?? dl;
  return page;
}

// ---------- JSON Patch for language variants ----------

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Applies the variantOverrides patch for `language` to a deep copy. Supports replace/add/remove only. */
export function applyVariantOverrides(doc: unknown, language: string): unknown {
  const out: Json = structuredClone(doc);
  for (const o of arr(out?.variantOverrides)) {
    if (!arr(o?.traits).some((t: Json) => t?.interfaceLanguage === language)) continue;
    for (const op of arr(o.patch)) applyOp(out, op);
  }
  return out;
}

function applyOp(root: Json, op: Json) {
  if (!["replace", "add", "remove"].includes(op?.op)) throw new Error(`unsupported JSON Patch op: ${op?.op}`);
  if (typeof op.path !== "string" || !op.path.startsWith("/")) throw new Error(`bad JSON Pointer: ${op.path}`);
  const parts = op.path.slice(1).split("/").map((p: string) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some((p: string) => UNSAFE_KEYS.has(p))) throw new Error(`unsafe JSON Pointer: ${op.path}`);
  let target: Json = root;
  for (const p of parts.slice(0, -1)) {
    const next = Array.isArray(target) ? target[Number(p)] : isObj(target) && Object.hasOwn(target, p) ? target[p] : undefined;
    if (next === undefined || next === null || typeof next !== "object") throw new Error(`JSON Pointer not found: ${op.path}`);
    target = next;
  }
  const last = parts.at(-1)!;
  if (Array.isArray(target)) {
    if (last === "-" && op.op === "add") return void target.push(op.value);
    const i = Number(last);
    if (!Number.isInteger(i) || i < 0 || i > target.length) throw new Error(`bad array index: ${op.path}`);
    if (op.op === "add") target.splice(i, 0, op.value);
    else if (op.op === "replace") target[i] = op.value;
    else target.splice(i, 1);
    return;
  }
  if (op.op === "remove") {
    if (!Object.hasOwn(target, last)) throw new Error(`JSON Pointer not found: ${op.path}`);
    delete target[last];
  } else target[last] = op.value; // replace on a missing final key just sets it
}

// ---------- page-level helpers ----------

function isRenderNode(x: unknown): boolean {
  const j = x as Json;
  return isObj(j) && isObj(j.metadata) && isObj(j.identifier) && typeof j.identifier.url === "string";
}

function languagesOf(json: Json, base: string): string[] {
  const langs: string[] = [];
  for (const v of arr(json.variants)) for (const t of arr(v?.traits)) if (typeof t?.interfaceLanguage === "string" && !langs.includes(t.interfaceLanguage)) langs.push(t.interfaceLanguage);
  return langs.length ? langs : [base];
}

function pageKindOf(json: Json, m: Json, url: string): PageKind {
  const role = m.role;
  if (json.kind === "project" || json.kind === "overview" || role === "project" || role === "overview" || role === "tutorial") return "tutorial";
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {}
  if (path.startsWith("/design/")) return "guideline";
  if (role === "sampleCode") return "sampleCode";
  if (role === "collection" || role === "collectionGroup") return "collection";
  if (role === "symbol" || json.kind === "symbol") return "api";
  if (role === "article" || json.kind === "article") return "article";
  return "other";
}

function availabilityOf(p: Json): Availability {
  const a: Availability = { platform: String(p.name ?? "") };
  if (p.introducedAt) a.introduced = String(p.introducedAt);
  if (p.deprecatedAt) a.deprecated = String(p.deprecatedAt);
  if (p.obsoletedAt) a.obsoleted = String(p.obsoletedAt);
  if (p.beta === true) a.beta = true;
  if (p.unavailable === true) a.unavailable = true;
  if (p.deprecated === true && !p.deprecatedAt) a.deprecatedNoVersion = true;
  return a;
}

function groups(sections: Json, ctx: Ctx): LinkGroup[] {
  return arr(sections)
    .filter(isObj)
    .map((s: Json) => ({ title: String(s.title ?? ""), items: arr(s.identifiers).map((id: Json) => linkItem(String(id), ctx)) }));
}

function linkItem(id: string, ctx: Ctx): LinkItem {
  const r = ctx.refs[id];
  if (!isObj(r)) return { title: id };
  const item: LinkItem = { title: String(r.title ?? id) };
  if (r.url) item.url = absUrl(String(r.url), ctx.base);
  const abstract = inline(r.abstract, ctx);
  if (abstract) item.abstract = abstract;
  if (r.kind) item.kind = String(r.kind);
  if (r.role) item.role = String(r.role);
  if (r.deprecated === true) item.deprecated = true;
  if (r.beta === true) item.beta = true;
  return item;
}

function linkList(ids: Json[], ctx: Ctx): string {
  return ids.map((id) => linkLine(linkItem(String(id), ctx))).join("\n");
}

export function linkLine(i: LinkItem): string {
  const t = i.kind === "symbol" ? code(i.title) : i.title;
  const link = i.url ? `[${t}](${i.url})` : t;
  const flags = [i.deprecated ? "deprecated" : "", i.beta ? "beta" : ""].filter(Boolean);
  return `- ${link}${flags.length ? ` (${flags.join(", ")})` : ""}${i.abstract ? ` — ${i.abstract}` : ""}`;
}

function heroOf(json: Json): Json {
  return arr(json.sections).find((s: Json) => s?.kind === "hero");
}

// ---------- primary sections ----------

function primarySection(s: Json, ctx: Ctx): string {
  switch (s.kind) {
    case "content":
      return blocks(s.content, ctx);
    case "restEndpoint":
      return section(s.title ?? "Endpoint", fence("http", tokens(s.tokens)));
    case "restParameters":
    case "properties":
      return section(s.title ?? (s.kind === "properties" ? "Properties" : "Parameters"), arr(s.items).map((i: Json) => fieldLine(i, ctx)).join("\n"));
    case "restBody": {
      const head = [s.mimeType ? `Content type: ${code(String(s.mimeType))}` : "", arr(s.bodyContentType).length ? `Type: ${code(tokens(s.bodyContentType))}` : ""].filter(Boolean).join("\n\n");
      const params = arr(s.parameters).map((i: Json) => fieldLine(i, ctx)).join("\n");
      return section(s.title ?? "HTTP Body", [head, blocks(s.content, ctx), params].filter(Boolean).join("\n\n"));
    }
    case "restResponses":
      return section(s.title ?? "Response Codes", arr(s.items).map((i: Json) => {
        const status = [i?.status, i?.reason].filter((x) => x !== undefined && x !== null && x !== "").join(" ");
        const type = tokens(i?.type);
        const mime = i?.mimeType ? ` (${i.mimeType})` : "";
        const text = blocks(i?.content, ctx);
        return `- **${status}**${type ? ` ${code(type)}` : ""}${mime}${text ? `: ${oneLine(text)}` : ""}`;
      }).join("\n"));
    case "possibleValues":
      return section(s.title ?? "Possible Values", arr(s.values).map((v: Json) => `- ${code(String(v?.name ?? ""))}${v?.content ? `: ${oneLine(blocks(v.content, ctx))}` : ""}`).join("\n"));
    case "details": {
      const d = s.details ?? {};
      const types = arr(d.value).map((v: Json) => (v?.arrayMode ? `array of ${v.baseType}` : String(v?.baseType ?? ""))).filter(Boolean);
      const lines = [d.name ? `- Name: ${code(String(d.name))}` : "", types.length ? `- Type: ${types.join(" or ")}` : "", d.ideTitle ? `- Xcode title: ${d.ideTitle}` : ""];
      return section(s.title ?? "Details", lines.filter(Boolean).join("\n"));
    }
    default:
      return genericSection(s, ctx, "section");
  }
}

function fieldLine(i: Json, ctx: Ctx): string {
  const type = tokens(i?.type);
  const meta = [type ? code(type) : "", i?.required ? "required" : "", i?.deprecated ? "deprecated" : "", i?.readOnly ? "read-only" : ""].filter(Boolean).join(", ");
  const attrs = arr(i?.attributes).map((a: Json) => `${a?.kind}: ${a?.value ?? arr(a?.values).join(", ")}`).join(", ");
  const text = blocks(i?.content, ctx);
  return `- ${code(String(i?.name ?? ""))}${meta ? ` (${meta})` : ""}${attrs ? ` — ${attrs}` : ""}${text ? `: ${oneLine(text)}` : ""}`;
}

function genericSection(s: Json, ctx: Ctx, what: string): string {
  record(ctx, `${what}:${s.kind}`);
  return section(s.title ?? s.kind ?? "Section", anyText(s, ctx));
}

// ---------- tutorials ----------

function tutorialSection(s: Json, ctx: Ctx): string {
  switch (s.kind) {
    case "hero": {
      const facts = [
        s.chapter ? `Chapter: ${s.chapter}` : "",
        s.estimatedTimeInMinutes ? `Estimated time: ${s.estimatedTimeInMinutes} min` : s.estimatedTime ? `Estimated time: ${s.estimatedTime}` : "",
        s.xcodeRequirement ? `Requires: ${ctx.refs[s.xcodeRequirement]?.title ?? s.xcodeRequirement}` : "",
      ].filter(Boolean);
      return [facts.join("\n\n"), blocks(s.content, ctx), s.action ? inline([s.action], ctx) : ""].filter(Boolean).join("\n\n");
    }
    case "tasks":
      return arr(s.tasks).map((t: Json) => tutorialTask(t, ctx)).join("\n\n");
    case "assessments":
      return section("Check your understanding", arr(s.assessments).map((a: Json, i: number) => {
        const q = [`**Question ${i + 1}.** ${oneLine(blocks(a?.title, ctx))}`, blocks(a?.content, ctx)].filter(Boolean).join("\n\n");
        const choices = arr(a?.choices).map((c: Json) => {
          const why = blocks(c?.justification, ctx);
          return `- [${c?.isCorrect ? "x" : " "}] ${oneLine(blocks(c?.content, ctx))}${why ? `\n  - ${oneLine(why)}` : ""}`;
        });
        return [q, choices.join("\n")].join("\n\n");
      }).join("\n\n"), 2);
    case "callToAction":
      return section(s.title ?? "Next", [inline(s.abstract, ctx), s.action ? inline([s.action], ctx) : ""].filter(Boolean).join("\n\n"), 2);
    case "volume": {
      const intro = [s.name ? `## ${s.name}` : "", blocks(s.content, ctx)].filter(Boolean).join("\n\n");
      const chapters = arr(s.chapters).map((c: Json) => section(c?.name ?? "Chapter", [blocks(c?.content, ctx), linkList(arr(c?.tutorials), ctx)].filter(Boolean).join("\n\n"), 2));
      return [intro, ...chapters].filter(Boolean).join("\n\n");
    }
    case "resources":
      return section("Resources", [blocks(s.content, ctx), ...arr(s.tiles).map((t: Json) => section(t?.title ?? "Resource", [blocks(t?.content, ctx), linkList(arr(t?.links ?? t?.identifiers), ctx)].filter(Boolean).join("\n\n"), 3))].filter(Boolean).join("\n\n"), 2);
    default:
      return genericSection(s, ctx, "section");
  }
}

function tutorialTask(t: Json, ctx: Ctx): string {
  const out = [`## ${t?.title ?? "Task"}`];
  for (const c of arr(t?.contentSection)) {
    out.push(blocks(c?.content, ctx));
    if (c?.media) out.push(mediaLine(String(c.media), ctx));
  }
  let n = 0;
  for (const st of arr(t?.stepsSection)) {
    if (st?.type !== "step") {
      out.push(blocks([st], ctx));
      continue;
    }
    n++;
    out.push(`${n}. ${oneLine(blocks(st.content, ctx))}`);
    const caption = blocks(st.caption, ctx);
    if (caption) out.push(caption);
    if (st.code) {
      const f = ctx.refs[st.code];
      if (isObj(f) && Array.isArray(f.content)) out.push(`${code(String(f.fileName ?? st.code))}\n\n${fence(String(f.syntax ?? f.fileType ?? ""), f.content.join("\n"))}`);
      else out.push(code(String(st.code)));
    }
    if (st.media) out.push(mediaLine(String(st.media), ctx));
  }
  return out.filter(Boolean).join("\n\n");
}

function mediaLine(id: string, ctx: Ctx): string {
  const r = ctx.refs[id];
  const u = mediaUrl(r, ctx.base);
  if (!u) return "";
  return r?.type === "video" ? `[Video: ${r.alt ?? id}](${u})` : `![${r?.alt ?? ""}](${u})`;
}

// ---------- blocks ----------

export function blocks(nodes: unknown, ctx: Ctx): string {
  return arr(nodes).map((n) => block(n, ctx)).filter(Boolean).join("\n\n");
}

function block(n: Json, ctx: Ctx): string {
  if (!isObj(n) || typeof n.type !== "string") return "";
  switch (n.type) {
    case "paragraph":
      return inline(n.inlineContent, ctx);
    case "heading": {
      const level = Math.min(6, Math.max(2, Number(n.level) || 2));
      return `${"#".repeat(level)} ${n.text ?? ""}`;
    }
    case "codeListing":
      return fence(String(n.syntax ?? ""), arr(n.code).join("\n"));
    case "aside": {
      const name = n.name ?? (n.style ? cap(String(n.style)) : "Note");
      const text = blocks(n.content, ctx);
      return `**${name}:** ${text}`.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    }
    case "unorderedList":
      return arr(n.items).map((i: Json) => listItem("- ", blocks(i?.content, ctx))).join("\n");
    case "orderedList": {
      const start = Number(n.start) || 1;
      return arr(n.items).map((i: Json, k: number) => listItem(`${start + k}. `, blocks(i?.content, ctx))).join("\n");
    }
    case "termList":
      return arr(n.items).map((i: Json) => listItem(`- **${inline(i?.term?.inlineContent, ctx)}**: `, blocks(i?.definition?.content, ctx))).join("\n");
    case "table":
      return table(n, ctx);
    case "tabNavigator":
      return arr(n.tabs).map((t: Json) => `**${t?.title ?? "Tab"}**\n\n${blocks(t?.content, ctx)}`).join("\n\n");
    case "links":
      return linkList(arr(n.items), ctx);
    case "row":
      return arr(n.columns).map((c: Json) => blocks(c?.content, ctx)).filter(Boolean).join("\n\n");
    case "small":
      return inline(n.inlineContent, ctx);
    case "thematicBreak":
      return "---";
    case "image":
    case "video":
      return mediaLine(String(n.identifier ?? ""), ctx);
    default: {
      record(ctx, `block:${n.type}`);
      const text = anyText(n, ctx);
      return `${text}${text ? "\n" : ""}<!-- unsupported: ${n.type} -->`;
    }
  }
}

function table(n: Json, ctx: Ctx): string {
  const rows: string[][] = arr(n.rows).map((r: Json) => arr(r).map((c: Json) => blocks(c, ctx).replace(/\|/g, "\\|").replace(/\n+/g, "<br>")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const header = n.header === "row" ? rows.shift()! : Array(width).fill("");
  return [line(header), line(Array(width).fill("---")), ...rows.map(line)].join("\n");
}

function listItem(marker: string, text: string): string {
  const indent = " ".repeat(marker.startsWith("- **") ? 2 : marker.length);
  return marker + text.split("\n").map((l, i) => (i === 0 || !l ? l : indent + l)).join("\n");
}

// ---------- inline ----------

export function inline(nodes: unknown, ctx: Ctx): string {
  return arr(nodes).map((n) => inlineNode(n, ctx)).join("");
}

function inlineNode(n: Json, ctx: Ctx): string {
  if (!isObj(n)) return "";
  switch (n.type) {
    case "text":
      return String(n.text ?? "");
    case "codeVoice":
      return code(String(n.code ?? ""));
    case "emphasis":
    case "newTerm":
      return `*${inline(n.inlineContent, ctx)}*`;
    case "strong":
    case "inlineHead":
      return `**${inline(n.inlineContent, ctx)}**`;
    case "strikethrough":
      return `~~${inline(n.inlineContent, ctx)}~~`;
    case "superscript":
    case "subscript":
      return inline(n.inlineContent, ctx);
    case "reference": {
      const id = String(n.identifier ?? "");
      const r = ctx.refs[id];
      if (!isObj(r)) return code(id);
      const title = n.overridingTitle ?? r.title ?? r.url ?? id;
      const text = r.kind === "symbol" && !n.overridingTitle ? code(String(title)) : String(title);
      const url = r.type === "download" ? undefined : r.url ? absUrl(String(r.url), ctx.base) : undefined;
      return n.isActive === false || !url ? text : `[${text}](${url})`;
    }
    case "link":
      return n.destination ? `[${n.title ?? inline(n.titleInlineContent, ctx) ?? n.destination}](${n.destination})` : String(n.title ?? "");
    case "image":
    case "video":
      return mediaLine(String(n.identifier ?? ""), ctx);
    default: {
      if (typeof n.type === "string") record(ctx, `inline:${n.type}`);
      return n.inlineContent ? inline(n.inlineContent, ctx) : typeof n.text === "string" ? n.text : "";
    }
  }
}

// ---------- small utilities ----------

/** Best-effort text of an unknown node: its inline content, nested blocks, or list items. */
function anyText(n: Json, ctx: Ctx): string {
  const parts: string[] = [];
  if (n.inlineContent) parts.push(inline(n.inlineContent, ctx));
  if (n.content) parts.push(blocks(n.content, ctx));
  for (const i of arr(n.items)) parts.push(isObj(i) && i.content ? blocks(i.content, ctx) : "");
  return parts.filter(Boolean).join("\n\n");
}

function tokens(t: unknown): string {
  return arr(t).map((x: Json) => String(x?.text ?? "")).join("");
}

function section(title: string, content: string, level = 3): string {
  return content ? `${"#".repeat(level)} ${title}\n\n${content}` : "";
}

export function fence(lang: string, text: string): string {
  const syntax = lang === "occ" ? "objc" : lang === "data" ? "" : lang;
  const ticks = text.includes("```") ? "~~~~" : "```";
  return `${ticks}${syntax}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

export function code(s: string): string {
  if (!s.includes("`")) return `\`${s}\``;
  return `\`\` ${s} \`\``;
}

function oneLine(s: string): string {
  return s.replace(/\n{2,}/g, " ").trim();
}

function mediaUrl(r: Json, base: string): string | undefined {
  const variants = arr(r?.variants);
  const v = variants.find((x: Json) => arr(x?.traits).includes("light")) ?? variants[0];
  return v?.url ? absUrl(String(v.url), base) : undefined;
}

function absUrl(u: string, base: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  return u.startsWith("/") ? base + u : u;
}

function record(ctx: Ctx, what: string) {
  if (!ctx.unsupported.includes(what)) ctx.unsupported.push(what);
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function arr(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

function isObj(x: unknown): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
