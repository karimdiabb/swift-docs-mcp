// DocPage -> one Markdown document for the model to read.
// Order: title, kind line, source, notices, abstract, declaration, parameters, availability, body, links, footer.
import { code, fence, linkLine } from "./docc-parser.ts";
import type { Availability, DocPage, LinkGroup, PageKind } from "./types.ts";

export type RenderOptions = {
  fetchedAt: number;
  fromCache: boolean;
  /** Max items per topic/relationship/see-also group (default: all). */
  maxRelated?: number;
  /** Include topics, relationships and see-also (default true). */
  includeRelated?: boolean;
};

const KIND_LABEL: Record<PageKind, string> = {
  api: "API reference",
  article: "Article",
  tutorial: "Tutorial",
  sampleCode: "Sample code",
  guideline: "Human Interface Guidelines",
  collection: "Collection",
  other: "Documentation",
};
const LANG_LABEL: Record<string, string> = { swift: "Swift", occ: "Objective-C", data: "Data" };
const langLabel = (l: string) => LANG_LABEL[l] ?? l;

export function renderMarkdown(p: DocPage, o: RenderOptions): string {
  const out: string[] = [`# ${p.title || "(untitled)"}`];

  out.push([p.roleHeading ? `**${p.roleHeading}**` : "", p.framework ?? "", KIND_LABEL[p.pageKind]].filter(Boolean).join(" · "));
  const info = [`Source: ${p.url}`];
  if (p.availableLanguages.length > 1) info.push(`Languages: ${p.availableLanguages.map(langLabel).join(", ")}`, `Language shown: ${langLabel(p.language)}`);
  out.push(info.join("\n"));

  if (p.deprecated) out.push(`> **Deprecated.**${p.deprecationSummary ? " " + p.deprecationSummary.replace(/\n+/g, " ") : ""}`);
  if (p.abstract) out.push(p.abstract);

  if (p.declarations.length) out.push(`## Declaration\n\n${p.declarations.map((d) => fence(d.languages[0] ?? p.language, d.code)).join("\n\n")}`);
  if (p.parameters.length) out.push(`## Parameters\n\n${p.parameters.map((x) => `- ${code(x.name)}: ${x.markdown.replace(/\n+/g, " ")}`).join("\n")}`);
  if (p.availability.length) out.push(`## Availability\n\n${p.availability.map(availabilityLine).join("\n")}`);
  if (p.downloadId) out.push(`Download: available from the page at ${p.url}`);

  if (p.body) out.push(p.body);

  if (o.includeRelated !== false) {
    for (const [title, groups] of [["Topics", p.topics], ["Relationships", p.relationships], ["See Also", p.seeAlso]] as const) {
      const g = renderGroups(groups, o.maxRelated);
      if (g) out.push(`## ${title}\n\n${g}`);
    }
  }

  if (p.unsupported.length) out.push(`Note: some content types are not fully rendered: ${p.unsupported.join(", ")}. Their text is included above.`);

  const when = new Date(o.fetchedAt).toISOString();
  out.push(`---\nRetrieved ${when} from Apple (${o.fromCache ? "from local cache" : "not cached"}). Source: Apple Developer Documentation.`);
  return out.filter(Boolean).join("\n\n");
}

function availabilityLine(a: Availability): string {
  if (a.unavailable) return `- ${a.platform}: unavailable`;
  let s = `- ${a.platform}${a.introduced ? ` ${a.introduced}+` : ""}`;
  if (a.beta) s += " (beta)";
  if (a.deprecated) s += ` — deprecated ${a.deprecated}`;
  else if (a.deprecatedNoVersion) s += " — deprecated";
  if (a.obsoleted) s += `, obsoleted ${a.obsoleted}`;
  return s;
}

function renderGroups(groups: LinkGroup[], max?: number): string {
  return groups
    .filter((g) => g.items.length)
    .map((g) => {
      const shown = max === undefined ? g.items : g.items.slice(0, max);
      const more = g.items.length - shown.length;
      return [`### ${g.title || "Related"}`, shown.map(linkLine).join("\n") + (more > 0 ? `\n\n…and ${more} more` : "")].join("\n\n");
    })
    .join("\n\n");
}
