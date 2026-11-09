// Opt-in: real requests to developer.apple.com. Run with `npm run test:integration`.
// Expected values are taken from Apple's raw JSON fetched in the same run (not hardcoded),
// so the test checks our pipeline against the live source rather than against a snapshot.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AppleClient } from "../../src/apple/client.ts";
import { DocService } from "../../src/apple/docs.ts";
import { DocCache } from "../../src/cache/cache.ts";
import { parseDocUrl } from "../../src/security/url.ts";

const enabled = process.env.RUN_INTEGRATION === "1";
const A = "https://developer.apple.com";
const dir = mkdtempSync(join(tmpdir(), "sdm-int-"));
const client = new AppleClient({ minIntervalMs: 1000 });
const service = new DocService({ client, cache: new DocCache({ dir }) });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function raw(pageUrl: string): Promise<any> {
  const r = await client.getJson(parseDocUrl(pageUrl).dataUrl);
  if (r.status !== 200) throw new Error(`unexpected ${r.status}`);
  return r.data;
}
const declOf = (json: any) =>
  (json.primaryContentSections ?? []).filter((s: any) => s.kind === "declarations").flatMap((s: any) => s.declarations.map((d: any) => d.tokens.map((t: any) => t.text).join("")));

describe.skipIf(!enabled)("real Apple documentation", () => {
  it.each([
    [`${A}/documentation/swiftui/view`, "api"],
    [`${A}/documentation/foundation/url`, "api"],
    [`${A}/documentation/foundation/nsdecimalnumber/decimalnumberwithdecimal:`, "api"],
  ])("%s matches Apple's JSON", async (url, kind) => {
    const json = await raw(url);
    const r = await service.getDoc(url);
    expect(r.page.title).toBe(json.metadata.title);
    expect(r.page.url).toBe(url);
    expect(r.page.pageKind).toBe(kind);
    expect(r.page.declarations.map((d) => d.code)).toEqual(declOf(json));
    expect(r.page.declarations.length).toBeGreaterThan(0);
    expect(r.page.availability.length).toBe((json.metadata.platforms ?? []).length);
    expect(r.markdown).toContain(`Source: ${url}`);
    expect(r.page.unsupported).toEqual([]);
  });

  it("renders a real tutorial with steps", async () => {
    const url = `${A}/tutorials/swiftui/creating-and-combining-views`;
    const json = await raw(url);
    const r = await service.getDoc(url);
    expect(r.page.pageKind).toBe("tutorial");
    expect(r.page.title).toBe(json.metadata.title);
    const firstTask = json.sections.find((s: any) => s.kind === "tasks").tasks[0].title;
    expect(r.markdown).toContain(`## ${firstTask}`);
    expect(r.markdown).toMatch(/\n1\. /);
  });

  it("serves the second request from cache", async () => {
    const r = await service.getDoc(`${A}/documentation/swiftui/view`);
    expect(r.fromCache).toBe(true);
  });
});
