// Parsed documentation page: the stable shape every tool works with.
// Field names follow Apple's terminology where possible. Optional = Apple did not provide it.

export type PageKind = "api" | "article" | "tutorial" | "sampleCode" | "guideline" | "collection" | "other";

export type Availability = {
  platform: string;
  introduced?: string;
  deprecated?: string;
  obsoleted?: string;
  beta?: boolean;
  unavailable?: boolean;
  /** Deprecated without a version (DocC "deprecated": true). */
  deprecatedNoVersion?: boolean;
};

export type Declaration = {
  /** Exact declaration text, tokens joined in order. Never rebuilt or reformatted. */
  code: string;
  languages: string[];
  platforms: string[];
};

export type Parameter = { name: string; markdown: string };

export type LinkItem = {
  title: string;
  url?: string;
  abstract?: string;
  kind?: string;
  role?: string;
  deprecated?: boolean;
  beta?: boolean;
};

export type LinkGroup = { title: string; items: LinkItem[] };

export type DocPage = {
  /** Canonical human URL of the page. */
  url: string;
  /** DocC identifier (doc://...). */
  identifier: string;
  /** Interface language of this rendering (swift, occ, data...). */
  language: string;
  availableLanguages: string[];
  pageKind: PageKind;
  role?: string;
  roleHeading?: string;
  symbolKind?: string;
  title: string;
  framework?: string;
  abstract: string;
  declarations: Declaration[];
  parameters: Parameter[];
  availability: Availability[];
  deprecated: boolean;
  deprecationSummary?: string;
  /** Markdown for everything else: discussion, return value, REST/properties sections, tutorial steps... */
  body: string;
  topics: LinkGroup[];
  relationships: LinkGroup[];
  seeAlso: LinkGroup[];
  /** Raw DocC identifier of a sample-code download (the download host is not verified, so no URL is built). */
  downloadId?: string;
  /** Block/inline/section types we do not render natively. Their text is still kept in the output. */
  unsupported: string[];
};
