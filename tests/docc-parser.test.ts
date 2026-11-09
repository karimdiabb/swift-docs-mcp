// Expected values come from the real Apple JSON in tests/fixtures (fetched 2026-11-09), not from memory.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyVariantOverrides, parseRenderNode } from "../src/apple/docc-parser.ts";
import { AppleHttpError } from "../src/apple/client.ts";

const A = "https://developer.apple.com";
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const parse = (name: string, path: string, language?: "swift" | "occ") => parseRenderNode(fx(name), { url: A + path, ...(language ? { language } : {}) });

describe("declarations are exact", () => {
  it.each([
    ["protocol", "/documentation/swiftui/view", "@MainActor @preconcurrency protocol View"],
    ["struct", "/documentation/swiftui/navigationstack", "nonisolated struct NavigationStack<Data, Root> where Root : View"],
    ["overloadHash", "/documentation/swiftui/dynamicproperty/update()-9fxv4", "mutating func update()"],
    ["op", "/documentation/swift/int/+(_:_:)", "static func + (lhs: Int, rhs: Int) -> Int"],
    ["macro", "/documentation/swift/debugdescription()", "@attached(member) @attached(memberAttribute) macro DebugDescription()"],
    ["typealias", "/documentation/cryptokit/sha512/digest", "typealias Digest = SHA512Digest"],
    ["occOnly", "/documentation/foundation/nsdecimalnumber/decimalnumberwithdecimal:", "+ (NSDecimalNumber *) decimalNumberWithDecimal:(NSDecimal) dcm;"],
  ])("%s", (name, path, code) => {
    const p = parse(name, path);
    expect(p.declarations.map((d) => d.code)).toEqual([code]);
  });

  it("keeps declaration languages and platforms", () => {
    const d = parse("protocol", "/documentation/swiftui/view").declarations[0];
    expect(d.languages).toEqual(["swift"]);
    expect(d.platforms).toContain("visionOS");
  });
});

describe("metadata and page kinds", () => {
  it("reads title, role heading, symbol kind, framework and abstract", () => {
    const p = parse("protocol", "/documentation/swiftui/view");
    expect(p).toMatchObject({
      url: `${A}/documentation/swiftui/view`,
      identifier: "doc://com.apple.SwiftUI/documentation/SwiftUI/View",
      title: "View",
      roleHeading: "Protocol",
      symbolKind: "protocol",
      framework: "SwiftUI",
      pageKind: "api",
      language: "swift",
    });
    expect(p.abstract).toBe("A type that represents part of your app’s user interface and provides modifiers that you use to configure views.");
  });

  it.each([
    ["article", "/documentation/swiftui/migrating-to-the-swiftui-life-cycle", "article"],
    ["sampleCode", "/documentation/metal/drawing-a-triangle-with-metal-4", "sampleCode"],
    ["frameworkRoot", "/documentation/storekit", "collection"],
    ["collection", "/documentation/uikit/protecting-the-user-s-privacy", "collection"],
    ["hig", "/design/human-interface-guidelines/color", "guideline"],
    ["tutorialPage", "/tutorials/swiftui/creating-and-combining-views", "tutorial"],
    ["tutorialsRoot", "/tutorials/swiftui", "tutorial"],
    ["httpRequest", "/documentation/appstoreserverapi/get-transaction-info", "api"],
  ])("%s -> %s", (name, path, kind) => {
    expect(parse(name, path).pageKind).toBe(kind);
  });

  it("rejects JSON that is not a DocC RenderNode", () => {
    for (const bad of [null, [], "x", {}, { metadata: {} }, { identifier: { url: "doc://x" } }]) {
      expect(() => parseRenderNode(bad, { url: A + "/documentation/x" })).toThrow(AppleHttpError);
    }
  });

  it("tolerates a minimal page with only metadata and identifier", () => {
    const p = parseRenderNode({ metadata: { title: "T" }, identifier: { url: "doc://x/documentation/x", interfaceLanguage: "swift" }, kind: "article" }, { url: A + "/documentation/x" });
    expect(p).toMatchObject({ title: "T", abstract: "", declarations: [], parameters: [], availability: [], topics: [], deprecated: false });
  });
});

describe("availability and deprecation", () => {
  it("reads per-platform introduced versions", () => {
    const a = parse("protocol", "/documentation/swiftui/view").availability;
    expect(a.find((x) => x.platform === "iOS")).toEqual({ platform: "iOS", introduced: "13.0" });
    expect(a.find((x) => x.platform === "macOS")).toEqual({ platform: "macOS", introduced: "10.15" });
    expect(parse("protocol", "/documentation/swiftui/view").deprecated).toBe(false);
  });

  it("reads deprecated versions and the deprecation summary", () => {
    const p = parse("enumCase", "/documentation/storekit/skproductdiscount/type-swift.enum/introductory");
    expect(p.deprecated).toBe(true);
    expect(p.availability.find((x) => x.platform === "macOS")).toEqual({ platform: "macOS", introduced: "10.14.4", deprecated: "15.0" });
    expect(p.availability.find((x) => x.platform === "watchOS")).toEqual({ platform: "watchOS", introduced: "6.2", deprecated: "11.0" });
    expect(p.deprecationSummary).toBe("Use Product.SubscriptionOffer.OfferType.");
  });

  it("marks a page deprecated from platform data alone", () => {
    const p = parse("deprecated", "/documentation/uikit/uiapplication/launchoptionskey/bluetoothcentrals");
    expect(p.deprecated).toBe(true);
    expect(p.availability[0]).toEqual({ platform: "iOS", introduced: "7.0", deprecated: "26.0" });
  });

  it("keeps beta, unavailable and versionless deprecation flags", () => {
    const p = parseRenderNode(
      { metadata: { title: "T", platforms: [{ name: "iOS", introducedAt: "27.0", beta: true }, { name: "tvOS", unavailable: true }, { name: "macOS", deprecated: true }] }, identifier: { url: "doc://x/documentation/x" }, kind: "symbol" },
      { url: A + "/documentation/x" },
    );
    expect(p.availability).toEqual([
      { platform: "iOS", introduced: "27.0", beta: true },
      { platform: "tvOS", unavailable: true },
      { platform: "macOS", deprecatedNoVersion: true },
    ]);
    expect(p.deprecated).toBe(true);
  });
});

describe("Objective-C variant (variantOverrides = JSON Patch)", () => {
  const path = "/documentation/storekit/skproductdiscount/type-swift.enum/introductory";

  it("lists both languages and renders Swift by default", () => {
    const p = parse("enumCase", path);
    expect(p.availableLanguages).toEqual(["swift", "occ"]);
    expect(p.language).toBe("swift");
    expect(p.title).toBe("SKProductDiscount.Type.introductory");
    expect(p.declarations[0].code).toBe("case introductory");
  });

  it("applies the occ patch: title, declaration, platforms", () => {
    const p = parse("enumCase", path, "occ");
    expect(p.language).toBe("occ");
    expect(p.title).toBe("SKProductDiscountTypeIntroductory");
    expect(p.roleHeading).toBe("Enumeration Case");
    expect(p.declarations).toEqual([expect.objectContaining({ code: "SKProductDiscountTypeIntroductory", languages: ["occ"] })]);
    expect(p.availability.find((x) => x.platform === "macOS")).toEqual({ platform: "macOS", introduced: "10.14.4", deprecated: "15.0" });
  });

  it("does not mutate the input JSON", () => {
    const json = fx("enumCase");
    const before = JSON.stringify(json);
    parseRenderNode(json, { url: A + path, language: "occ" });
    expect(JSON.stringify(json)).toBe(before);
  });

  it("falls back to the page's own language when the requested one is missing", () => {
    expect(parse("protocol", "/documentation/swiftui/view", "occ").language).toBe("swift");
    expect(parse("occOnly", "/documentation/foundation/nsdecimalnumber/decimalnumberwithdecimal:", "swift").language).toBe("occ");
  });

  describe("applyVariantOverrides", () => {
    const doc = () => ({ a: { b: 1, "x/y": 2, "t~s": 3 }, list: [1, 2], variantOverrides: [] as unknown[] });
    const withPatch = (patch: unknown[]) => ({ ...doc(), variantOverrides: [{ traits: [{ interfaceLanguage: "occ" }], patch }] });

    it("handles replace/add/remove and ~1 / ~0 escapes", () => {
      const out = applyVariantOverrides(
        withPatch([
          { op: "replace", path: "/a/b", value: 10 },
          { op: "replace", path: "/a/x~1y", value: 20 },
          { op: "remove", path: "/a/t~0s" },
          { op: "add", path: "/a/new", value: true },
          { op: "add", path: "/list/-", value: 3 },
          { op: "add", path: "/list/0", value: 0 },
        ]),
        "occ",
      ) as any;
      expect(out.a).toEqual({ b: 10, "x/y": 20, new: true });
      expect(out.list).toEqual([0, 1, 2, 3]);
    });

    it("returns the document unchanged when no override matches", () => {
      expect(applyVariantOverrides(withPatch([{ op: "replace", path: "/a/b", value: 9 }]), "swift")).toMatchObject({ a: { b: 1 } });
    });

    it("throws on unsupported ops and bad paths instead of guessing", () => {
      expect(() => applyVariantOverrides(withPatch([{ op: "move", from: "/a/b", path: "/a/c" }]), "occ")).toThrow();
      expect(() => applyVariantOverrides(withPatch([{ op: "replace", path: "/missing/deep", value: 1 }]), "occ")).toThrow();
      expect(() => applyVariantOverrides(withPatch([{ op: "replace", path: "/__proto__/polluted", value: 1 }]), "occ")).toThrow();
      // A final-segment __proto__ write would swap the object's prototype: must be refused too.
      expect(() => applyVariantOverrides(withPatch([{ op: "replace", path: "/__proto__", value: { polluted: 1 } }]), "occ")).toThrow();
      expect(() => applyVariantOverrides(withPatch([{ op: "add", path: "/a/constructor", value: 1 }]), "occ")).toThrow();
      expect(({} as any).polluted).toBeUndefined();
    });
  });
});

describe("parameters, content and links", () => {
  it("reads parameters with their descriptions", () => {
    const p = parse("op", "/documentation/swift/int/+(_:_:)");
    expect(p.parameters).toEqual([
      { name: "lhs", markdown: "The first value to add." },
      { name: "rhs", markdown: "The second value to add." },
    ]);
  });

  it("renders discussion with code listings and asides", () => {
    const body = parse("op", "/documentation/swift/int/+(_:_:)").body;
    expect(body).toContain("## Discussion");
    expect(body).toContain("The addition operator (`+`) calculates the sum of its two arguments.");
    expect(body).toContain("```swift\n1 + 2                   // 3\n");
    expect(body).toMatch(/> \*\*Note:\*\* Overflow checking is not performed in `-Ounchecked` builds\./);
  });

  it("resolves topic groups through references with absolute URLs", () => {
    const p = parse("frameworkRoot", "/documentation/storekit");
    expect(p.topics.map((g) => g.title).slice(0, 4)).toEqual(["Apple In-App Purchase", "App transaction", "Messages", "Reviews"]);
    const item = p.topics[0].items[0];
    expect(item.url).toMatch(/^https:\/\/developer\.apple\.com\/documentation\/storekit\//);
    expect(item.title.length).toBeGreaterThan(0);
  });

  it("reads relationships and see-also groups", () => {
    const p = parse("protocol", "/documentation/swiftui/view");
    expect(p.relationships.map((g) => [g.title, g.items.length])).toEqual([["Inherited By", 10], ["Conforming Types", 158]]);
    expect(p.relationships[0].items[0].title).toBe("DynamicViewContent");
    expect(p.topics.slice(0, 3).map((g) => [g.title, g.items.length])).toEqual([["Implementing a custom view", 4], ["Configuring view elements", 5], ["Drawing views", 3]]);
    expect(p.seeAlso.length).toBeGreaterThan(0);
  });

  it("renders HIG tables as Markdown tables", () => {
    const body = parse("hig", "/design/human-interface-guidelines/color").body;
    expect(body).toMatch(/\| Color \| Use for… \| UIKit API \|\n\| --- \| --- \| --- \|\n\| Label \| A text label that contains primary content\. \| /);
  });

  it("renders term lists (framework overview)", () => {
    const body = parse("frameworkRoot", "/documentation/storekit").body;
    expect(body).toContain("- **Apple In-App Purchase**: Offer and promote Apple In-App Purchases for content and services.");
  });

  it("keeps the sample-code download id without inventing a download URL", () => {
    const p = parse("sampleCode", "/documentation/metal/drawing-a-triangle-with-metal-4");
    expect(p.downloadId).toBe("afbc1ba209ed/DrawingATriangleWithMetal4.zip");
  });

  it("renders a video block as a link with its alt text", () => {
    const p = parse("sampleCode", "/documentation/metal/drawing-a-triangle-with-metal-4");
    expect(p.body).toMatch(/\[Video: A short video of a slowly rotating triangle on a dark background\.[^\]]*\]\(https:\/\/developer\.apple\.com\/[^)]+\)/);
    expect(p.unsupported).toEqual([]);
  });

  it("renders tab navigators with each tab's code", () => {
    const body = parse("sampleCode", "/documentation/metal/drawing-a-triangle-with-metal-4").body;
    expect(body).toContain("if ([view.device supportsFamily:MTLGPUFamilyMetal4]) {");
  });
});

describe("REST, dictionary and property-list pages", () => {
  it("renders REST endpoints, parameters and responses", () => {
    const p = parse("httpRequest", "/documentation/appstoreserverapi/get-transaction-info");
    expect(p.body).toContain("```http\nGET https://api.storekit.apple.com/inApps/v1/transactions/{transactionId}\n```");
    expect(p.body).toContain("### Sandbox URL");
    expect(p.body).toContain("### Path Parameters");
    expect(p.body).toMatch(/- `transactionId` \(`transactionId`, required\): The identifier of a transaction/);
    expect(p.body).toMatch(/- \*\*200 OK\*\* `TransactionInfoResponse`/);
    expect(p.body).toMatch(/- \*\*429\*\* `RateLimitExceededError`/);
  });

  it("renders dictionary properties with type, required flag and attributes", () => {
    const p = parse("dictionarySymbol", "/documentation/appstoreserverapi/jwstransactiondecodedpayload");
    expect(p.declarations[0]).toMatchObject({ code: "object JWSTransactionDecodedPayload", languages: ["data"] });
    expect(p.body).toContain("### Properties");
    expect(p.body).toMatch(/- `revocationPercentage` \(`revocationPercentage`\) — minimum: 0, maximum: 100000: /);
  });

  it("renders property-list key details", () => {
    const body = parse("propertyListKey", "/documentation/bundleresources/information-property-list/cfbundleidentifier").body;
    expect(body).toContain("### Details");
    expect(body).toContain("- Name: `CFBundleIdentifier`");
    expect(body).toContain("- Type: string");
    expect(body).toContain("- Xcode title: Bundle identifier");
  });
});

describe("tutorials", () => {
  const p = () => parse("tutorialPage", "/tutorials/swiftui/creating-and-combining-views");

  it("renders hero metadata", () => {
    expect(p().title).toBe("Creating and combining views");
    expect(p().body).toContain("Estimated time: 40 min");
    expect(p().body).toContain("Requires: Xcode 15 or later");
  });

  it("renders tasks with numbered steps and the step's code file", () => {
    const body = p().body;
    expect(body).toContain("## Create a new project and explore the canvas");
    expect(body).toContain("1. Open Xcode and either click “Create New Project” in Xcode’s startup window, or choose File > New > Project.");
    expect(body).toContain("`LandmarksApp.swift`");
    expect(body).toContain("```swift\nimport SwiftUI\n\n@main\nstruct LandmarksApp: App {");
  });

  it("renders assessments with the correct answer marked", () => {
    const body = p().body;
    expect(body).toContain("When creating a custom SwiftUI view, where do you declare the view’s layout?");
    expect(body).toContain("- [x] In the `body` property."); // Apple marks `body` as code voice
    expect(body).toContain("- [ ] In the view’s initializer.");
  });

  it("renders the tutorials overview chapters with tutorial links", () => {
    const t = parse("tutorialsRoot", "/tutorials/swiftui");
    expect(t.title).toBe("Introducing SwiftUI");
    expect(t.body).toContain("## SwiftUI essentials");
    expect(t.body).toMatch(/\[Creating and combining views\]\(https:\/\/developer\.apple\.com\/tutorials\/swiftui\/creating-and-combining-views\)/);
  });
});

describe("unknown content is preserved, not dropped", () => {
  const page = (content: unknown[]) =>
    parseRenderNode(
      { metadata: { title: "T" }, identifier: { url: "doc://x/documentation/x" }, kind: "article", primaryContentSections: [{ kind: "content", content }], references: {} },
      { url: A + "/documentation/x" },
    );

  it("keeps the text of an unknown block type and records it", () => {
    const p = page([{ type: "futureBlock", inlineContent: [{ type: "text", text: "Keep me" }] }]);
    expect(p.body).toContain("Keep me");
    expect(p.body).toContain("<!-- unsupported: futureBlock -->");
    expect(p.unsupported).toEqual(["block:futureBlock"]);
  });

  it("keeps the text of an unknown inline type", () => {
    const p = page([{ type: "paragraph", inlineContent: [{ type: "text", text: "a " }, { type: "sparkle", inlineContent: [{ type: "text", text: "b" }] }] }]);
    expect(p.body).toContain("a b");
    expect(p.unsupported).toEqual(["inline:sparkle"]);
  });

  it("keeps an unknown primary section", () => {
    const p = parseRenderNode(
      { metadata: { title: "T" }, identifier: { url: "doc://x/documentation/x" }, kind: "symbol", primaryContentSections: [{ kind: "newThing", title: "New Thing", content: [{ type: "paragraph", inlineContent: [{ type: "text", text: "inside" }] }] }] },
      { url: A + "/documentation/x" },
    );
    expect(p.body).toContain("### New Thing");
    expect(p.body).toContain("inside");
    expect(p.unsupported).toEqual(["section:newThing"]);
  });

  it("renders an unresolvable reference as its identifier text, not a broken link", () => {
    const p = page([{ type: "paragraph", inlineContent: [{ type: "reference", identifier: "doc://x/documentation/Missing", isActive: true }] }]);
    expect(p.body).toContain("`doc://x/documentation/Missing`");
  });

  it("drops unknown types from external input without throwing on odd values", () => {
    expect(() => page([null, 5, "str", { type: 7 }, { type: "paragraph" }])).not.toThrow();
  });
});
