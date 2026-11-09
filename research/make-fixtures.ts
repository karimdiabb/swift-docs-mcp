// Copies real Apple page JSON (saved by pages.ts) into tests/fixtures.
// Only trimming: drop `references` entries that nothing else in the page mentions. Content is unchanged.
// Usage: OUT_DIR=<dir with page-*.json> node research/make-fixtures.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR } from "./http.ts";

const PAGES = ["protocol", "struct", "overloadHash", "init", "op", "enumCase", "macro", "typealias", "deprecated", "occOnly", "article", "sampleCode", "collection", "frameworkRoot", "hig", "tutorialPage", "tutorialsRoot", "httpRequest", "dictionarySymbol", "propertyListKey"];
const dest = "tests/fixtures";
mkdirSync(dest, { recursive: true });

for (const name of PAGES) {
  const page = JSON.parse(readFileSync(join(OUT_DIR, `page-${name}.json`), "utf8"));
  const { references = {}, ...rest } = page;
  const used = new Set<string>();
  const collect = (x: unknown) => {
    if (typeof x === "string") used.add(x);
    else if (Array.isArray(x)) x.forEach(collect);
    else if (x && typeof x === "object") Object.values(x).forEach(collect);
  };
  collect(rest);
  // references can point at other references (e.g. a topic's images), so close over them.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, v] of Object.entries<any>(references)) {
      if (!used.has(k)) continue;
      const before = used.size;
      collect(v);
      if (used.size > before) grew = true;
    }
  }
  const kept = Object.fromEntries(Object.entries(references).filter(([k]) => used.has(k)));
  writeFileSync(join(dest, `${name}.json`), JSON.stringify({ ...rest, references: kept }));
  console.log(`${name.padEnd(18)} refs ${Object.keys(references).length} -> ${Object.keys(kept).length}`);
}
