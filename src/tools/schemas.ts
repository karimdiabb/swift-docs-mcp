// Strict input schemas (unknown keys rejected). Lengths are capped; everything else is validated downstream.
import { z } from "zod";
import { PLATFORM_NAMES } from "./context.ts";

const platformByLower = new Map(PLATFORM_NAMES.map((p) => [p.toLowerCase(), p]));
export const platform = z
  .string()
  .max(20)
  .transform((s, ctx) => {
    const p = platformByLower.get(s.trim().toLowerCase());
    if (!p) {
      ctx.addIssue({ code: "custom", message: `platform must be one of ${PLATFORM_NAMES.join(", ")}` });
      return z.NEVER;
    }
    return p;
  });
const framework = z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N} ._+-]+$/u, "letters, digits, spaces and . _ + - only");

export const searchInput = z
  .object({
    query: z.string().trim().min(1).max(200).describe("Symbol, API, framework, concept or natural-language topic"),
    framework: framework.optional().describe("Framework or collection, e.g. SwiftUI, UIKit, Foundation, human-interface-guidelines"),
    platform: platform.optional().describe(`One of ${PLATFORM_NAMES.join(", ")}`),
    kind: z.enum(["api", "article", "tutorial", "sample_code", "guideline", "collection", "other"]).optional().describe("Page kind filter"),
    limit: z.number().int().min(1).max(30).optional().describe("Results per page (default 10, max 30)"),
    cursor: z.string().max(100).regex(/^[A-Za-z0-9_-]+$/).optional().describe("Pagination cursor from a previous result"),
  })
  .strict();

export const docInput = z
  .object({
    url: z.string().max(2048).describe("Canonical Apple documentation URL, e.g. https://developer.apple.com/documentation/swiftui/view (add ?language=objc for Objective-C)"),
    include_related: z.boolean().optional().describe("Include topics, relationships and see-also (default true)"),
    max_related: z.number().int().min(0).max(30).optional().describe("Max items per related group (default 10, max 30)"),
  })
  .strict();

export const apiInput = z
  .object({
    symbol: z.string().trim().min(1).max(300).describe("Symbol name, optionally qualified: NavigationStack, View.onAppear, SwiftUI.View, frame(width:height:alignment:)"),
    framework: framework.optional().describe("Framework to narrow the match, e.g. SwiftUI"),
    platform: platform.optional().describe(`Only symbols available on this platform: ${PLATFORM_NAMES.join(", ")}`),
  })
  .strict();

export const statusInput = z.object({}).strict();
