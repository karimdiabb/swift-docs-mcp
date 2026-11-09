import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.ts";

describe("parseCli", () => {
  it("parses index build/refresh with options", () => {
    expect(parseCli(["index", "build"])).toEqual({ cmd: "sync", mode: "build", intervalMs: 1000, maxWalkPages: 3000 });
    expect(parseCli(["index", "refresh", "--only", "swiftui,UIKit", "--interval-ms", "500", "--max-walk", "50"])).toEqual({ cmd: "sync", mode: "refresh", only: ["swiftui", "uikit"], intervalMs: 500, maxWalkPages: 50 });
  });

  it("parses enrich with defaults and options", () => {
    expect(parseCli(["index", "enrich"])).toMatchObject({ cmd: "enrich", max: 1000, kinds: ["struct", "class", "protocol", "enum", "actor", "collection", "article", "sampleCode"], intervalMs: 1000 });
    expect(parseCli(["index", "enrich", "--kinds", "macro", "--framework", "SwiftUI", "--max", "20"])).toMatchObject({ cmd: "enrich", kinds: ["macro"], framework: "swiftui", max: 20 });
  });

  it("parses status, cache clear, doc and help", () => {
    expect(parseCli(["index", "status"])).toEqual({ cmd: "status" });
    expect(parseCli(["cache", "clear"])).toEqual({ cmd: "cache-clear" });
    expect(parseCli(["doc", "https://developer.apple.com/documentation/swiftui/view"])).toEqual({ cmd: "doc", url: "https://developer.apple.com/documentation/swiftui/view", maxRelated: 10, objc: false });
    expect(parseCli(["doc", "https://developer.apple.com/documentation/foundation/nsstring", "--objc", "--related", "3"])).toMatchObject({ objc: true, maxRelated: 3 });
    expect(parseCli([])).toEqual({ cmd: "help" });
    expect(parseCli(["--help"])).toEqual({ cmd: "help" });
  });

  it.each([
    [["index"]],
    [["index", "nope"]],
    [["frobnicate"]],
    [["index", "build", "--interval-ms", "100"]],
    [["index", "build", "--interval-ms", "abc"]],
    [["index", "enrich", "--max", "0"]],
    [["index", "build", "--unknown"]],
    [["doc"]],
  ])("rejects %j", (argv) => {
    expect(() => parseCli(argv)).toThrow();
  });
});
