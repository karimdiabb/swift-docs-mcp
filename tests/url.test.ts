import { describe, expect, it } from "vitest";
import { assertFetchable, parseDocUrl, UrlRejected } from "../src/security/url.ts";

const A = "https://developer.apple.com";

describe("parseDocUrl: accepted inputs", () => {
  it("maps a documentation page to its DocC JSON URL", () => {
    const u = parseDocUrl(`${A}/documentation/swiftui/view`);
    expect(u.host).toBe("developer.apple.com");
    expect(u.path).toBe("/documentation/swiftui/view");
    expect(u.humanUrl).toBe(`${A}/documentation/swiftui/view`);
    expect(u.dataUrl).toBe(`${A}/tutorials/data/documentation/swiftui/view.json`);
    expect(u.key).toBe("developer.apple.com/documentation/swiftui/view");
    expect(u.language).toBeUndefined();
  });

  it("lowercases, drops trailing slash, fragment and unrelated query", () => {
    const u = parseDocUrl(`${A}/documentation/SwiftUI/View/?foo=1#overview`);
    expect(u.path).toBe("/documentation/swiftui/view");
    expect(u.humanUrl).toBe(`${A}/documentation/swiftui/view`);
  });

  it("reads ?language=objc as the Objective-C variant", () => {
    expect(parseDocUrl(`${A}/documentation/foundation/nsstring?language=objc`).language).toBe("occ");
    expect(parseDocUrl(`${A}/documentation/foundation/nsstring?language=swift`).language).toBe("swift");
  });

  it("accepts HIG and tutorial pages (paths verified in Phase 1)", () => {
    expect(parseDocUrl(`${A}/design/human-interface-guidelines/color`).dataUrl).toBe(`${A}/tutorials/data/design/human-interface-guidelines/color.json`);
    expect(parseDocUrl(`${A}/design/human-interface-guidelines`).path).toBe("/design/human-interface-guidelines");
    expect(parseDocUrl(`${A}/tutorials/swiftui/creating-and-combining-views`).dataUrl).toBe(`${A}/tutorials/data/tutorials/swiftui/creating-and-combining-views.json`);
  });

  it("keeps operator, overload-hash and selector paths intact (real paths from Phase 1)", () => {
    expect(parseDocUrl(`${A}/documentation/swift/int/+(_:_:)`).dataUrl).toBe(`${A}/tutorials/data/documentation/swift/int/+(_:_:).json`);
    expect(parseDocUrl(`${A}/documentation/swiftui/dynamicproperty/update()-9fxv4`).path).toBe("/documentation/swiftui/dynamicproperty/update()-9fxv4");
    expect(parseDocUrl(`${A}/documentation/foundation/nsdecimalnumber/decimalnumberwithdecimal:`).path).toBe("/documentation/foundation/nsdecimalnumber/decimalnumberwithdecimal:");
  });

  // DocC escapes unsafe operator characters as "_" and prefixes dot-leading names with "'".
  // Both paths below are from the real Swift navigator index and returned 200 (checked 2026-11-09).
  it("keeps escaped operator paths intact (not traversal)", () => {
    expect(parseDocUrl(`${A}/documentation/swift/int/'...(_:_:)`).dataUrl).toBe(`${A}/tutorials/data/documentation/swift/int/'...(_:_:).json`);
    expect(parseDocUrl(`${A}/documentation/swift/int/&__=(_:_:)-58orm`).dataUrl).toBe(`${A}/tutorials/data/documentation/swift/int/&__=(_:_:)-58orm.json`);
  });

  it("treats an explicit default port as the same URL", () => {
    expect(parseDocUrl("https://developer.apple.com:443/documentation/swiftui/view").path).toBe("/documentation/swiftui/view");
  });
});

describe("parseDocUrl: rejected inputs", () => {
  const rejected: [string, string][] = [
    ["http scheme", "http://developer.apple.com/documentation/swiftui/view"],
    ["other scheme", "file:///etc/passwd"],
    ["no scheme", "developer.apple.com/documentation/swiftui/view"],
    ["relative path", "/documentation/swiftui/view"],
    ["credentials", "https://user:pw@developer.apple.com/documentation/swiftui/view"],
    ["username only", "https://user@developer.apple.com/documentation/swiftui/view"],
    ["nonstandard port", "https://developer.apple.com:8443/documentation/swiftui/view"],
    ["IPv4 literal", "https://17.253.144.10/documentation/swiftui/view"],
    ["IPv6 literal", "https://[::1]/documentation/swiftui/view"],
    ["suffix lookalike", "https://developer.apple.com.evil.com/documentation/swiftui/view"],
    ["hyphen lookalike", "https://developer-apple.com/documentation/swiftui/view"],
    ["subdomain of allowed", "https://x.developer.apple.com/documentation/swiftui/view"],
    ["parent domain", "https://apple.com/documentation/swiftui/view"],
    ["punycode lookalike", "https://xn--developer-apple-com.example/documentation/swiftui/view"],
    ["unicode lookalike", "https://developer.аpple.com/documentation/swiftui/view"],
    ["trailing dot host", "https://developer.apple.com./documentation/swiftui/view"],
    ["dot-dot segment", `${A}/documentation/../search/x`],
    ["single dot segment", `${A}/documentation/./swiftui/view`],
    ["encoded dot-dot", `${A}/documentation/%2e%2e/search/x`],
    ["mixed encoded dot-dot", `${A}/documentation/.%2E/search/x`],
    ["encoded slash", `${A}/documentation/swiftui%2fview`],
    ["encoded backslash", `${A}/documentation/swiftui%5cview`],
    ["backslash", `${A}/documentation\\swiftui\\view`],
    ["control character", `${A}/documentation/swiftui/view\u0000`],
    ["whitespace", `${A}/documentation/swiftui /view`],
    ["invalid percent escape", `${A}/documentation/swiftui/%zz`],
    ["overlong", `${A}/documentation/${"a".repeat(3000)}`],
    ["empty", ""],
    ["documentation root only", `${A}/documentation`],
    ["documentation root slash", `${A}/documentation/`],
    ["not a docs path", `${A}/videos/play/wwdc2023/10148`],
    ["robots-disallowed docs path", `${A}/documentation/dataformats/foo`],
    ["data path given directly", `${A}/tutorials/data/documentation/swiftui/view.json`],
    ["empty segment", `${A}/documentation//swiftui`],
  ];
  it.each(rejected)("rejects %s", (_name, input) => {
    expect(() => parseDocUrl(input)).toThrow(UrlRejected);
  });

  it("rejects non-string input", () => {
    expect(() => parseDocUrl(42 as unknown as string)).toThrow(UrlRejected);
  });
});

describe("assertFetchable", () => {
  it("allows DocC data and navigator index URLs", () => {
    expect(assertFetchable(`${A}/tutorials/data/documentation/swiftui/view.json`).href).toBe(`${A}/tutorials/data/documentation/swiftui/view.json`);
    expect(assertFetchable(`${A}/tutorials/data/index/swiftui`).pathname).toBe("/tutorials/data/index/swiftui");
    expect(assertFetchable(new URL(`${A}/tutorials/data/documentation/technologies.json`)).hostname).toBe("developer.apple.com");
  });

  const blocked: [string, string][] = [
    ["human page (not data)", `${A}/documentation/swiftui/view`],
    ["search", `${A}/search/?q=view`],
    ["traversal out of data prefix", `${A}/tutorials/data/../../search/x`],
    ["other host", "https://example.com/tutorials/data/documentation/swiftui/view.json"],
    ["http", "http://developer.apple.com/tutorials/data/documentation/swiftui/view.json"],
    ["credentials", "https://a:b@developer.apple.com/tutorials/data/x.json"],
    ["port", "https://developer.apple.com:444/tutorials/data/x.json"],
    ["image CDN (links only, never fetched)", "https://devimages-cdn.apple.com/tutorials/data/x.json"],
    ["garbage", "not a url"],
  ];
  it.each(blocked)("blocks %s", (_name, input) => {
    expect(() => assertFetchable(input)).toThrow(UrlRejected);
  });

  it("resolves a relative redirect against the current URL before checking", () => {
    expect(assertFetchable("/tutorials/data/documentation/swiftui/view.json", `${A}/tutorials/data/x.json`).href).toBe(`${A}/tutorials/data/documentation/swiftui/view.json`);
    expect(() => assertFetchable("/search/x", `${A}/tutorials/data/x.json`)).toThrow(UrlRejected);
    expect(() => assertFetchable("//evil.com/tutorials/data/x.json", `${A}/tutorials/data/x.json`)).toThrow(UrlRejected);
  });
});
