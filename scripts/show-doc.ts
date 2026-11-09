// Dev helper: print the rendered Markdown for one documentation page.
// Usage: npm run doc -- <https://developer.apple.com/documentation/...> [--related N]
import { AppleClient } from "../src/apple/client.ts";
import { DocService } from "../src/apple/docs.ts";
import { appDir, DocCache } from "../src/cache/cache.ts";

const [url, flag, n] = process.argv.slice(2);
if (!url) {
  console.error("usage: npm run doc -- <documentation URL> [--related N]");
  process.exit(2);
}
const service = new DocService({ client: new AppleClient(), cache: new DocCache({ dir: appDir() }) });
const r = await service.getDoc(url, flag === "--related" ? { maxRelated: Number(n) } : { maxRelated: 5 });
console.log(r.markdown);
