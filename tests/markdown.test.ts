import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRenderNode } from "../src/apple/docc-parser.ts";
import { renderMarkdown } from "../src/apple/markdown.ts";

const A = "https://developer.apple.com";
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const page = (name: string, path: string, language?: "swift" | "occ") => parseRenderNode(fx(name), { url: A + path, ...(language ? { language } : {}) });
const meta = { fetchedAt: Date.UTC(2026, 10, 9, 12, 0, 0), fromCache: false };

describe("renderMarkdown", () => {
  const view = () => renderMarkdown(page("protocol", "/documentation/swiftui/view"), meta);

  it("starts with title, kind line and canonical source URL", () => {
    const md = view();
    expect(md.startsWith("# View\n\n")).toBe(true);
    expect(md).toContain("**Protocol** · SwiftUI · API reference");
    expect(md).toContain(`Source: ${A}/documentation/swiftui/view`);
  });

  it("shows the exact declaration in a fenced block", () => {
    expect(view()).toContain("## Declaration\n\n```swift\n@MainActor @preconcurrency protocol View\n```");
  });

  it("lists availability per platform", () => {
    const md = view();
    expect(md).toContain("## Availability");
    expect(md).toContain("- iOS 13.0+");
    expect(md).toContain("- macOS 10.15+");
  });

  it("puts the abstract before the declaration and the body after availability", () => {
    const md = view();
    const iAbstract = md.indexOf("A type that represents part of your app’s user interface");
    const iDecl = md.indexOf("## Declaration");
    const iAvail = md.indexOf("## Availability");
    const iTopics = md.indexOf("## Topics");
    expect(iAbstract).toBeGreaterThan(0);
    expect(iAbstract).toBeLessThan(iDecl);
    expect(iDecl).toBeLessThan(iAvail);
    expect(iAvail).toBeLessThan(iTopics);
  });

  it("renders topic, relationship and see-also groups as links", () => {
    const md = view();
    expect(md).toContain("## Topics\n\n### Implementing a custom view\n\n- ");
    expect(md).toContain("## Relationships\n\n### Inherited By");
    expect(md).toMatch(/- \[`DynamicViewContent`\]\(https:\/\/developer\.apple\.com\/documentation\/swiftui\/dynamicviewcontent\)/);
    expect(md).toContain("## See Also");
  });

  it("caps each related group at maxRelated and says how many were left out", () => {
    const md = renderMarkdown(page("protocol", "/documentation/swiftui/view"), { ...meta, maxRelated: 10 });
    const conforming = md.slice(md.indexOf("### Conforming Types"));
    const section = conforming.slice(0, conforming.indexOf("\n## ") === -1 ? undefined : conforming.indexOf("\n## "));
    expect(section.match(/^- /gm)).toHaveLength(10);
    expect(section).toContain("…and 148 more");
  });

  it("can omit related groups entirely", () => {
    const md = renderMarkdown(page("protocol", "/documentation/swiftui/view"), { ...meta, includeRelated: false });
    expect(md).not.toContain("## Topics");
    expect(md).not.toContain("## Relationships");
    expect(md).not.toContain("## See Also");
    expect(md).toContain("## Declaration");
  });

  it("ends with retrieval time and cache status", () => {
    expect(view()).toMatch(/\n---\nRetrieved 2026-11-09T12:00:00\.000Z from Apple \(not cached\)\. Source: Apple Developer Documentation\.$/);
    expect(renderMarkdown(page("protocol", "/documentation/swiftui/view"), { ...meta, fromCache: true })).toContain("(from local cache)");
  });

  it("shows a deprecation notice and deprecated versions", () => {
    const md = renderMarkdown(page("enumCase", "/documentation/storekit/skproductdiscount/type-swift.enum/introductory"), meta);
    expect(md).toContain("> **Deprecated.** Use Product.SubscriptionOffer.OfferType.");
    expect(md).toContain("- macOS 10.14.4+ — deprecated 15.0");
    expect(md).toContain("Languages: Swift, Objective-C");
  });

  it("renders the Objective-C variant with an objc fence", () => {
    const md = renderMarkdown(page("enumCase", "/documentation/storekit/skproductdiscount/type-swift.enum/introductory", "occ"), meta);
    expect(md.startsWith("# SKProductDiscountTypeIntroductory\n")).toBe(true);
    expect(md).toContain("```objc\nSKProductDiscountTypeIntroductory\n```");
    expect(md).toContain("Language shown: Objective-C");
  });

  it("drops trailing newlines inside a declaration fence (display only)", () => {
    const p = page("protocol", "/documentation/swiftui/view");
    p.declarations[0].code += "\n";
    expect(renderMarkdown(p, meta)).toContain("protocol View\n```");
  });

  it("renders parameters", () => {
    const md = renderMarkdown(page("op", "/documentation/swift/int/+(_:_:)"), meta);
    expect(md).toContain("## Parameters\n\n- `lhs`: The first value to add.\n- `rhs`: The second value to add.");
  });

  it("renders beta, unavailable and versionless deprecation", () => {
    const p = parseRenderNode(
      { metadata: { title: "T", platforms: [{ name: "iOS", introducedAt: "27.0", beta: true }, { name: "tvOS", unavailable: true }, { name: "macOS", introducedAt: "10.0", deprecated: true }] }, identifier: { url: "doc://x/documentation/x" }, kind: "symbol" },
      { url: A + "/documentation/x" },
    );
    const md = renderMarkdown(p, meta);
    expect(md).toContain("- iOS 27.0+ (beta)");
    expect(md).toContain("- tvOS: unavailable");
    expect(md).toContain("- macOS 10.0+ — deprecated");
  });

  it("points to the page for sample-code downloads instead of inventing a URL", () => {
    const md = renderMarkdown(page("sampleCode", "/documentation/metal/drawing-a-triangle-with-metal-4"), meta);
    expect(md).toContain(`Download: available from the page at ${A}/documentation/metal/drawing-a-triangle-with-metal-4`);
    expect(md).toContain("Sample code");
  });

  it("uses a plain fence for data declarations and labels guideline pages", () => {
    expect(renderMarkdown(page("dictionarySymbol", "/documentation/appstoreserverapi/jwstransactiondecodedpayload"), meta)).toContain("```\nobject JWSTransactionDecodedPayload\n```");
    expect(renderMarkdown(page("hig", "/design/human-interface-guidelines/color"), meta)).toContain("Human Interface Guidelines");
  });

  it("omits empty sections", () => {
    const p = parseRenderNode({ metadata: { title: "T" }, identifier: { url: "doc://x/documentation/x" }, kind: "article" }, { url: A + "/documentation/x" });
    const md = renderMarkdown(p, meta);
    for (const h of ["## Declaration", "## Parameters", "## Availability", "## Topics", "## Relationships", "## See Also"]) expect(md).not.toContain(h);
  });

  it("lists unsupported content types so gaps are visible", () => {
    const p = parseRenderNode(
      { metadata: { title: "T" }, identifier: { url: "doc://x/documentation/x" }, kind: "article", primaryContentSections: [{ kind: "content", content: [{ type: "futureBlock" }] }] },
      { url: A + "/documentation/x" },
    );
    expect(renderMarkdown(p, meta)).toContain("Note: some content types are not fully rendered: block:futureBlock");
  });
});
