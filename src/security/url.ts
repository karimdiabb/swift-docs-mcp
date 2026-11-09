// URL canonicalization and validation. Every URL the server fetches goes through here.
//
// Two entry points:
// - parseDocUrl: a human documentation URL (from the model or a search result) -> canonical page + data URL.
// - assertFetchable: the last check before any request, including every redirect hop.
//
// The raw input is checked BEFORE WHATWG URL parsing. The parser silently resolves "..", "%2e%2e" and "\",
// which would otherwise hide traversal attempts.

export class UrlRejected extends Error {
  readonly reason: string;
  constructor(reason: string, input: unknown) {
    super(`URL rejected (${reason}): ${String(input).slice(0, 200)}`);
    this.name = "UrlRejected";
    this.reason = reason;
  }
}

export type Language = "swift" | "occ";

export type DocUrl = {
  host: string;
  /** Decoded, lowercase canonical path, e.g. /documentation/swiftui/view */
  path: string;
  humanUrl: string;
  dataUrl: string;
  /** Stable cache/index key: host + path */
  key: string;
  language?: Language;
};

const MAX_LENGTH = 2048;

// Exact host allowlist. docs.swift.org (Swift book) gets added only after its endpoints are probed.
const HOSTS: Record<string, { pagePrefixes: string[]; fetchPrefix: string; toData: (path: string) => string }> = {
  "developer.apple.com": {
    pagePrefixes: ["/documentation/", "/design/human-interface-guidelines", "/tutorials/"],
    fetchPrefix: "/tutorials/data/",
    toData: (path) => `/tutorials/data${path}.json`,
  },
};

// robots.txt of developer.apple.com (checked 2026-11-09). Applies to page paths and fetch paths.
const ROBOTS_DISALLOWED = ["/cgi-bin/", "/click/", "/documentation/dataformats/", "/reference/", "/search/", "/survey/", "/temp/", "/unsubscribe/", "/forums/"];

export function parseDocUrl(input: string): DocUrl {
  checkRaw(input);
  const url = parseUrl(input);
  checkOrigin(url, input);
  const host = HOSTS[url.hostname];

  // Use the raw path from the input, not url.pathname, so encoded traversal can be seen.
  const rawPath = rawPathOf(input);
  const segments = rawPath.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop(); // trailing slash
  const decoded = segments.map((s) => decodeSegment(s, input));
  const path = "/" + decoded.join("/").toLowerCase();

  if (path.startsWith("/tutorials/data/") || path === "/tutorials/data") throw new UrlRejected("data path, pass the page URL", input);
  const prefixOk = host.pagePrefixes.some((p) => (p.endsWith("/") ? path.startsWith(p) && path.length > p.length : path === p || path.startsWith(p + "/")));
  if (!prefixOk) throw new UrlRejected("not a documentation page", input);
  if (isRobotsDisallowed(path)) throw new UrlRejected("robots-disallowed", input);

  const lang = url.searchParams.get("language")?.toLowerCase();
  const language: Language | undefined = lang === "objc" || lang === "occ" ? "occ" : lang === "swift" ? "swift" : undefined;

  const origin = `https://${url.hostname}`;
  return {
    host: url.hostname,
    path,
    humanUrl: origin + encodePath(path),
    dataUrl: origin + encodePath(host.toData(path)),
    key: url.hostname + path,
    ...(language ? { language } : {}),
  };
}

/** Throws unless `target` (resolved against `base`, for redirects) is an allowed fetch URL. */
export function assertFetchable(target: string | URL, base?: string | URL): URL {
  let url: URL;
  try {
    url = new URL(target, base);
  } catch {
    throw new UrlRejected("unparseable", target);
  }
  checkOrigin(url, target);
  const host = HOSTS[url.hostname];
  // url.pathname is already resolved here, so "/tutorials/data/../../x" has become "/x" and fails the prefix.
  if (!url.pathname.startsWith(host.fetchPrefix)) throw new UrlRejected("path outside fetch prefix", target);
  if (isRobotsDisallowed(url.pathname.toLowerCase())) throw new UrlRejected("robots-disallowed", target);
  return url;
}

function checkRaw(input: unknown): asserts input is string {
  if (typeof input !== "string" || input.length === 0) throw new UrlRejected("empty or not a string", input);
  if (input.length > MAX_LENGTH) throw new UrlRejected("too long", input);
  if (/[\u0000- \u007f]/.test(input)) throw new UrlRejected("control or whitespace character", input);
  if (input.includes("\\")) throw new UrlRejected("backslash", input);
  if (!/^https:\/\//i.test(input)) throw new UrlRejected("must start with https://", input);
}

function parseUrl(input: string): URL {
  try {
    return new URL(input);
  } catch {
    throw new UrlRejected("unparseable", input);
  }
}

function checkOrigin(url: URL, input: unknown) {
  if (url.protocol !== "https:") throw new UrlRejected("not https", input);
  if (url.username || url.password) throw new UrlRejected("credentials in URL", input);
  if (url.port !== "") throw new UrlRejected("nonstandard port", input); // :443 is normalized to "" by the parser
  // Exact match only: covers IP literals, lookalikes, subdomains, punycode and trailing dots.
  if (!Object.hasOwn(HOSTS, url.hostname)) throw new UrlRejected("host not allowed", input);
}

function rawPathOf(input: string): string {
  const afterScheme = input.slice("https://".length);
  const slash = afterScheme.indexOf("/");
  if (slash === -1) return "/";
  const rest = afterScheme.slice(slash);
  return rest.split(/[?#]/, 1)[0];
}

function decodeSegment(seg: string, input: string): string {
  if (seg === "") throw new UrlRejected("empty path segment", input);
  let d: string;
  try {
    d = decodeURIComponent(seg);
  } catch {
    throw new UrlRejected("invalid percent escape", input);
  }
  if (d === "." || d === "..") throw new UrlRejected("dot segment", input);
  if (d.includes("/") || d.includes("\\")) throw new UrlRejected("encoded separator", input);
  if (/[\u0000-\u001f\u007f]/.test(d)) throw new UrlRejected("encoded control character", input);
  return d;
}

// Encode only what would change URL meaning; Apple's paths keep ( ) : + etc. literally (observed in Phase 1).
function encodePath(path: string): string {
  const pre = path.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23");
  return new URL(pre, "https://x").pathname;
}

function isRobotsDisallowed(path: string) {
  return ROBOTS_DISALLOWED.some((p) => path.startsWith(p) || path + "/" === p);
}
