// Expected counts were computed independently (Python) from the real WidgetKit navigator index.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNavigator, pageKindForNavType, symbolName, wordsOf } from "../src/index/navigator.ts";

const nav = JSON.parse(readFileSync(new URL("./fixtures/navigator-widgetkit.json", import.meta.url), "utf8"));

describe("parseNavigator (real WidgetKit index)", () => {
  const entries = parseNavigator(nav);
  const byPath = new Map(entries.map((e) => [e.path, e]));

  it("returns unique internal pages only (no externals, no group markers, no duplicates)", () => {
    expect(entries).toHaveLength(329);
    expect(new Set(entries.map((e) => e.path)).size).toBe(329);
    expect(byPath.has("/documentation/swiftui/widgetbundle")).toBe(false); // external: owned by SwiftUI
    expect(entries.some((e) => e.navType === "groupMarker")).toBe(false);
  });

  it("merges languages across the swift and occ trees", () => {
    expect(byPath.get("/documentation/widgetkit")?.languages).toEqual(["swift", "occ"]);
    expect(byPath.get("/documentation/widgetkit/wgwidgetuserinfokeyfamily")?.languages).toEqual(["occ"]);
    expect(byPath.get("/documentation/widgetkit/timelineprovider")?.languages).toEqual(["swift"]);
    expect(entries.filter((e) => e.languages.length === 2)).toHaveLength(34);
  });

  it("keeps title and type", () => {
    expect(byPath.get("/documentation/widgetkit/timelineprovider")).toMatchObject({ title: "TimelineProvider", navType: "protocol", pageKind: "api" });
    expect(byPath.get("/documentation/widgetkit/timelineprovider/placeholder(in:)")).toMatchObject({ title: "func placeholder(in: Self.Context) -> Self.Entry", navType: "method" });
  });

  it("counts types like the independent computation", () => {
    const count = (t: string) => entries.filter((e) => e.navType === t).length;
    expect([count("property"), count("method"), count("struct"), count("article"), count("sampleCode"), count("module")]).toEqual([70, 60, 49, 27, 2, 1]);
  });

  it("lowercases paths and reads deprecated/beta flags", () => {
    const e = parseNavigator({
      interfaceLanguages: {
        swift: [{ type: "module", title: "K", path: "/documentation/K", children: [
          { type: "groupMarker", title: "G" },
          { type: "class", title: "Old", path: "/documentation/K/Old", deprecated: true },
          { type: "struct", title: "New", path: "/documentation/K/New", beta: true },
          { type: "struct", title: "NoPath" },
        ] }],
      },
    });
    expect(e.map((x) => [x.path, x.deprecated, x.beta])).toEqual([
      ["/documentation/k", false, false],
      ["/documentation/k/old", true, false],
      ["/documentation/k/new", false, true],
    ]);
  });

  it("rejects input that is not a navigator index", () => {
    expect(() => parseNavigator({})).toThrow();
    expect(() => parseNavigator(null)).toThrow();
    expect(() => parseNavigator({ interfaceLanguages: [] })).toThrow();
  });
});

describe("helpers", () => {
  it.each([
    ["method", "/documentation/x/y", "api"],
    ["article", "/documentation/x/y", "article"],
    ["article", "/design/human-interface-guidelines/color", "guideline"],
    ["sampleCode", "/documentation/x/y", "sampleCode"],
    ["collection", "/documentation/x/y", "collection"],
    ["module", "/documentation/x", "collection"],
    ["httpRequest", "/documentation/x/y", "api"],
    ["project", "/tutorials/swiftui/x", "tutorial"],
    ["overview", "/tutorials/swiftui", "tutorial"],
    ["unknownFutureType", "/documentation/x/y", "api"],
  ])("pageKindForNavType(%s, %s) = %s", (t, p, k) => {
    expect(pageKindForNavType(t, p)).toBe(k);
  });

  it.each([
    ["/documentation/widgetkit/timelineprovider/placeholder(in:)", "placeholder(in:)"],
    ["/documentation/swiftui/dynamicproperty/update()-9fxv4", "update()"],
    ["/documentation/swift/int/&__=(_:_:)-58orm", "&__=(_:_:)"],
    ["/documentation/swiftui/view", "view"],
    ["/documentation/storekit/skproductdiscount/type-swift.enum", "type"],
  ])("symbolName(%s) = %s", (p, n) => {
    expect(symbolName(p)).toBe(n);
  });

  it("splits camelCase and punctuation into search words", () => {
    expect(wordsOf("NavigationStack")).toBe("navigation stack");
    expect(wordsOf("navigationDestination(for:destination:)")).toBe("navigation destination for destination");
    expect(wordsOf("URLSessionDataTask")).toBe("url session data task");
    expect(wordsOf("func placeholder(in: Self.Context) -> Self.Entry")).toBe("func placeholder in self context self entry");
  });
});
