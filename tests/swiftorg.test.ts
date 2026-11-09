// docs.swift.org (Swift book and other swift.org collections). Endpoints probed 2026-11-09:
// navigator /latest/index/index.json, pages /latest/data/documentation/<path>.json, human /latest/documentation/<path>.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRenderNode } from "../src/apple/docc-parser.ts";
import { parseSwiftOrgCollections } from "../src/index/navigator.ts";
import { assertFetchable, parseDocUrl, UrlRejected, urlForPath } from "../src/security/url.ts";

const S = "https://docs.swift.org";
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));

describe("swift.org URLs", () => {
  it("maps a book page to its data URL", () => {
    const u = parseDocUrl(`${S}/latest/documentation/the-swift-programming-language/thebasics`);
    expect(u).toMatchObject({
      host: "docs.swift.org",
      path: "/latest/documentation/the-swift-programming-language/thebasics",
      humanUrl: `${S}/latest/documentation/the-swift-programming-language/thebasics`,
      dataUrl: `${S}/latest/data/documentation/the-swift-programming-language/thebasics.json`,
      key: "docs.swift.org/latest/documentation/the-swift-programming-language/thebasics",
    });
  });

  it("canonicalizes the /swift-book/ alias (which redirects to /latest/) and case", () => {
    expect(parseDocUrl(`${S}/swift-book/documentation/The-Swift-Programming-Language/TheBasics/`).path).toBe("/latest/documentation/the-swift-programming-language/thebasics");
  });

  it.each([
    ["http", "http://docs.swift.org/latest/documentation/x"],
    ["other swift.org host", "https://www.swift.org/documentation/x"],
    ["index file as a page", `${S}/latest/index/index.json`],
    ["data path", `${S}/latest/data/documentation/x.json`],
    ["outside documentation", `${S}/latest/other/x`],
    ["traversal", `${S}/latest/documentation/../../etc`],
    ["lookalike", "https://docs.swift.org.evil.com/latest/documentation/x"],
  ])("rejects %s", (_n, u) => {
    expect(() => parseDocUrl(u)).toThrow(UrlRejected);
  });

  it("allows only the data and index prefixes for fetching", () => {
    expect(assertFetchable(`${S}/latest/data/documentation/the-swift-programming-language.json`).hostname).toBe("docs.swift.org");
    expect(assertFetchable(`${S}/latest/index/index.json`).pathname).toBe("/latest/index/index.json");
    for (const u of [`${S}/swift-book/data/x.json`, `${S}/latest/documentation/x`, `${S}/latest/other.json`]) expect(() => assertFetchable(u)).toThrow(UrlRejected);
  });

  it("maps stored paths back to their host", () => {
    expect(urlForPath("/latest/documentation/apiguidelines")).toBe(`${S}/latest/documentation/apiguidelines`);
    expect(urlForPath("/documentation/swiftui/view")).toBe("https://developer.apple.com/documentation/swiftui/view");
  });
});

describe("swift.org pages", () => {
  it("resolves relative links against docs.swift.org/latest, not developer.apple.com", () => {
    const p = parseRenderNode(fx("swiftorg-tspl-root"), { url: `${S}/latest/documentation/the-swift-programming-language` });
    expect(p.title).toBe("The Swift Programming Language (6.4)");
    expect(p.topics.map((g) => g.title)).toEqual(["Welcome to Swift", "Language Guide", "Language Reference", "Revision History"]);
    const first = p.topics[0].items[0];
    expect(first.url).toBe(`${S}/latest/documentation/the-swift-programming-language/aboutswift`);
    expect(p.pageKind).toBe("collection");
  });

  it("parses a book chapter as an article", () => {
    const p = parseRenderNode(fx("swiftorg-aboutswift"), { url: `${S}/latest/documentation/the-swift-programming-language/aboutswift` });
    expect(p.title).toBe("About Swift");
    expect(p.pageKind).toBe("article");
    expect(p.body).not.toContain("https://developer.apple.com/documentation/the-swift-programming-language");
  });
});

describe("parseSwiftOrgCollections", () => {
  const cols = parseSwiftOrgCollections(fx("navigator-swiftorg"));

  it("returns one collection per top-level module, with /latest-prefixed paths", () => {
    expect(cols.map((c) => [c.path, c.title, c.entries.length])).toEqual([
      ["/latest/documentation/the-swift-programming-language", "The Swift Programming Language", 44],
      ["/latest/documentation/apiguidelines", "API Guidelines", 33],
      ["/latest/documentation/swift", "Standard Library", 4],
    ]);
    expect(cols[0].slug).toBe("the-swift-programming-language");
    expect(cols[0].entries.every((e) => e.path.startsWith("/latest/documentation/"))).toBe(true);
  });

  it("skips group markers and resources that link to other sites", () => {
    expect(cols.some((c) => c.title === "Foundation")).toBe(false);
  });

  it("rejects input that is not a swift.org navigator index", () => {
    expect(() => parseSwiftOrgCollections({ interfaceLanguages: { swift: [] } })).toThrow();
  });
});
