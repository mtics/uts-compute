import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundedInteger } from "../../lib/shared.js";
import { redactLocalHome, redactProjectRoot } from "../../lib/redact.js";
import { assertInsideProject, assertInsideRuntime, projectRoot, assertRealPathInside, RUNTIME_DIRS } from "../../core/paths.js";
import { assertDocsCacheRecord } from "../../core/validation.js";
import type { DocsCacheRecord } from "../../core/types.js";

export const DOCS = [
  {
    id: "architecture",
    path: "docs/architecture.md",
    title: "Architecture"
  },
  {
    id: "implementation-plan",
    path: "docs/implementation-plan.md",
    title: "Implementation Plan"
  },
  {
    id: "composition-review",
    path: "docs/mcp-skills-composition-review.md",
    title: "MCP And Skills Composition Review"
  },
  {
    id: "accounts-and-safety",
    path: "docs/accounts-and-safety.md",
    title: "Accounts And Safety"
  },
  {
    id: "research-basis",
    path: "docs/research-basis.md",
    title: "Research Basis"
  },
  {
    id: "fact-registry",
    path: "docs/fact-registry.md",
    title: "Fact Registry"
  },
  {
    id: "validation-checklist",
    path: "docs/validation-checklist.md",
    title: "Validation Checklist"
  },
  {
    id: "plugin-setup",
    path: "docs/plugin-setup.md",
    title: "Plugin Setup"
  },
  {
    id: "client-installed-smoke-evidence",
    path: "docs/client-installed-smoke-evidence.md",
    title: "Client-Installed Smoke Evidence"
  },
  {
    id: "schema-migration-plan",
    path: "docs/schema-migration-plan.md",
    title: "Schema Migration Plan"
  },
  {
    id: "failure-playbooks",
    path: "docs/failure-playbooks.md",
    title: "Failure Playbooks"
  }
] as const;

export type DocId = (typeof DOCS)[number]["id"];

export const REMOTE_DOC_SOURCES = [
  {
    id: "uts-hpc-home",
    title: "UTS HPC Home",
    url: "https://hpc.research.uts.edu.au/"
  },
  {
    id: "uts-hpc-access",
    title: "UTS HPC Access",
    url: "https://hpc.research.uts.edu.au/getting_started/access/"
  },
  {
    id: "uts-hpc-pbs",
    title: "UTS HPC PBS",
    url: "https://hpc.research.uts.edu.au/pbs/"
  },
  {
    id: "uts-hpc-pbs-queues",
    title: "UTS HPC PBS Queues",
    url: "https://hpc.research.uts.edu.au/pbs/queues/"
  },
  {
    id: "uts-hpc-pbs-nodes",
    title: "UTS HPC PBS Nodes",
    url: "https://hpc.research.uts.edu.au/pbs/nodes/"
  },
  {
    id: "uts-hpc-gpu-job-submit",
    title: "UTS HPC GPU Job Submit",
    url: "https://hpc.research.uts.edu.au/gpu/job_submit/"
  },
  {
    id: "uts-hpc-status-queues",
    title: "UTS HPC Queue Status",
    url: "https://hpc.research.uts.edu.au/statuspbs/queues"
  },
  {
    id: "uts-ihpc-docs-rhel-810",
    title: "UTS iHPC RHEL 8/10 Documentation",
    url: "https://ihpc.research.uts.edu.au/help/documentation-rhel-810/"
  },
  {
    id: "uts-ihpc-node-limits",
    title: "UTS iHPC Node Limits",
    url: "https://ihpc.research.uts.edu.au/help/about/node-limits/"
  },
  {
    id: "uts-ihpc-usage-policy",
    title: "UTS iHPC Usage Policy",
    url: "https://ihpc.research.uts.edu.au/help/about/usage-policy/"
  }
] as const;

export type RemoteDocSourceId = (typeof REMOTE_DOC_SOURCES)[number]["id"];

export interface DocSearchInput {
  query: string;
  docIds?: string[];
  maxResults?: number;
  maxSnippetChars?: number;
}

export interface DocsRefreshInput {
  sourceIds?: string[];
  maxBytes?: number;
  timeoutMs?: number;
}

export interface DocsFetcherOptions {
  timeoutMs: number;
  maxBytes: number;
}

export interface DocsFetchResponse {
  status: number;
  headers?: Headers | Record<string, string | undefined>;
  body: string | Buffer | Uint8Array;
  finalUrl?: string;
}

export type DocsFetcher = (url: string, options: DocsFetcherOptions) => Promise<DocsFetchResponse>;

export interface DocsRefreshOptions {
  fetcher?: DocsFetcher;
  docsCacheDir?: string;
  now?: Date;
  writeCache?: boolean;
}

export interface DocSearchResult {
  mode: "read-only";
  source: "local-allowlisted-docs";
  query: string;
  docs_searched: string[];
  max_results: number;
  matches: Array<{
    doc_id: DocId;
    title: string;
    uri: string;
    line: number;
    score: number;
    snippet: string;
  }>;
  truncated: boolean;
}

export interface CachedDocSummary {
  source_id: string;
  title: string;
  source_url: string;
  observed_at: string;
  status_code: number;
  content_type: string;
  bytes: number;
  text_chars: number;
  content_hash: string;
  cache_uri: string;
}

export interface DocsRefreshSourceResult {
  source_id: string;
  title: string;
  source_url: string;
  cache_uri: string;
  status: "refreshed" | "failed";
  observed_at: string;
  status_code?: number;
  content_type?: string;
  bytes?: number;
  text_chars?: number;
  content_hash?: string;
  snippet?: string;
  warnings: string[];
  error?: string;
}

export interface DocsRefreshResult {
  refresh: {
    mode: "read-only";
    source: "fixed-official-uts-docs";
    cache: "local-docs-cache";
    observed_at: string;
    timeout_ms: number;
    max_bytes: number;
    sources_requested: string[];
    sources: DocsRefreshSourceResult[];
    warnings: string[];
  };
}

type DocSearchMatch = DocSearchResult["matches"][number];

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 20;
const DEFAULT_MAX_SNIPPET_CHARS = 220;
const MAX_SNIPPET_CHARS = 500;
const DEFAULT_REFRESH_TIMEOUT_MS = 10000;
const MAX_REFRESH_TIMEOUT_MS = 30000;
const DEFAULT_REFRESH_MAX_BYTES = 1_000_000;
const MAX_REFRESH_MAX_BYTES = 2_000_000;
const DOCS_CACHE_DIR = RUNTIME_DIRS.docsCache;
const ALLOWED_REMOTE_HOSTS = new Set(["hpc.research.uts.edu.au", "ihpc.research.uts.edu.au"]);
const ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain", "text/markdown", "application/xhtml+xml"]);

export function listDocs() {
  return DOCS.map((doc) => ({
    id: doc.id,
    title: doc.title,
    uri: `uts://docs/${doc.id}`
  }));
}

export function readDoc(docId: string): { id: DocId; title: string; path: string; text: string } {
  const doc = findDoc(docId);
  const docPath = resolveDocPath(doc.path);
  return {
    id: doc.id,
    title: doc.title,
    path: doc.path,
    text: fs.readFileSync(docPath, "utf8")
  };
}

export function searchDocs(input: DocSearchInput): { search: DocSearchResult } {
  const query = normalizeQuery(input.query);
  const terms = searchTerms(query);
  const maxResults = boundedInteger(input.maxResults, { default: DEFAULT_MAX_RESULTS, min: 1, max: MAX_RESULTS, label: "maxResults" });
  const maxSnippetChars = boundedInteger(input.maxSnippetChars, {
    default: DEFAULT_MAX_SNIPPET_CHARS,
    min: 80,
    max: MAX_SNIPPET_CHARS,
    label: "maxSnippetChars"
  });
  const docs = selectedDocs(input.docIds);
  const matches = docs.flatMap((doc) => searchOneDoc(doc, query, terms, maxSnippetChars));
  const sorted = matches.sort((left, right) => right.score - left.score || left.doc_id.localeCompare(right.doc_id) || left.line - right.line);

  return {
    search: {
      mode: "read-only",
      source: "local-allowlisted-docs",
      query,
      docs_searched: docs.map((doc) => doc.id),
      max_results: maxResults,
      matches: sorted.slice(0, maxResults),
      truncated: sorted.length > maxResults
    }
  };
}

export async function refreshDocs(input: DocsRefreshInput = {}, options: DocsRefreshOptions = {}): Promise<DocsRefreshResult> {
  const timeoutMs = boundedInteger(input.timeoutMs, {
    default: DEFAULT_REFRESH_TIMEOUT_MS,
    min: 1000,
    max: MAX_REFRESH_TIMEOUT_MS,
    label: "timeoutMs"
  });
  const maxBytes = boundedInteger(input.maxBytes, { default: DEFAULT_REFRESH_MAX_BYTES, min: 1024, max: MAX_REFRESH_MAX_BYTES, label: "maxBytes" });
  const sources = selectedRemoteSources(input.sourceIds);
  const observedAt = (options.now ?? new Date()).toISOString();
  const cacheDir = docsCacheDir(options.docsCacheDir, true);
  const fetcher = options.fetcher ?? defaultDocsFetcher;
  const results = await Promise.all(
    sources.map((source) =>
      refreshOneDocSource(source, {
        cacheDir,
        fetcher,
        maxBytes,
        observedAt,
        timeoutMs,
        writeCache: options.writeCache ?? true
      })
    )
  );
  const failed = results.filter((result) => result.status === "failed");

  return {
    refresh: {
      mode: "read-only",
      source: "fixed-official-uts-docs",
      cache: "local-docs-cache",
      observed_at: observedAt,
      timeout_ms: timeoutMs,
      max_bytes: maxBytes,
      sources_requested: sources.map((source) => source.id),
      sources: results,
      warnings: [
        "docs.refresh uses a fixed official UTS documentation source allowlist; it does not accept arbitrary URLs, paths, headers, profiles, or proxy settings",
        "Cached documentation is public/platform context only; account-specific quotas and permissions must still be checked with quotas.refresh",
        ...(failed.length > 0 ? [`${failed.length} documentation source(s) failed to refresh`] : [])
      ]
    }
  };
}

export function listRemoteDocSources() {
  return REMOTE_DOC_SOURCES.map((source) => ({
    id: source.id,
    title: source.title,
    source_url: source.url,
    cache_uri: `uts://docs-cache/${source.id}`
  }));
}

export function listCachedDocs(options: { docsCacheDir?: string } = {}): CachedDocSummary[] {
  const cacheDir = docsCacheDir(options.docsCacheDir, false);
  if (!fs.existsSync(cacheDir)) {
    return [];
  }
  return REMOTE_DOC_SOURCES.flatMap((source) => {
    const filePath = docsCacheFilePath(cacheDir, source.id);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const record = readCachedDoc(source.id, options);
      return [
        {
          source_id: record.source_id,
          title: record.title,
          source_url: record.source_url,
          observed_at: record.observed_at,
          status_code: record.status_code,
          content_type: record.content_type,
          bytes: record.bytes,
          text_chars: record.text_chars,
          content_hash: record.content_hash,
          cache_uri: `uts://docs-cache/${record.source_id}`
        }
      ];
    } catch {
      return [];
    }
  }).sort((left, right) => right.observed_at.localeCompare(left.observed_at) || left.source_id.localeCompare(right.source_id));
}

export function readCachedDoc(sourceId: string, options: { docsCacheDir?: string } = {}): DocsCacheRecord {
  const source = findRemoteDocSource(sourceId);
  const cacheDir = docsCacheDir(options.docsCacheDir, false);
  const filePath = docsCacheFilePath(cacheDir, source.id);
  assertRealPathInside(filePath, cacheDir, "Documentation cache file");
  const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  assertDocsCacheRecord(record);
  if (record.source_id !== source.id || record.source_url !== source.url) {
    throw new Error("Documentation cache record does not match the requested source");
  }
  return record;
}

export function formatCachedDoc(record: DocsCacheRecord): string {
  return [
    `# ${record.title}`,
    "",
    `Source: ${record.source_url}`,
    `Observed at: ${record.observed_at}`,
    `Status: ${record.status_code}`,
    `Content type: ${record.content_type}`,
    `Content hash: ${record.content_hash}`,
    "",
    record.text,
    ""
  ].join("\n");
}

function searchOneDoc(
  doc: (typeof DOCS)[number],
  query: string,
  terms: string[],
  maxSnippetChars: number
): DocSearchResult["matches"] {
  const text = readDoc(doc.id).text;
  const lowerQuery = query.toLowerCase();
  const matches: DocSearchMatch[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lower = line.toLowerCase();
    const termHits = terms.filter((term) => lower.includes(term));
    const phraseHit = lower.includes(lowerQuery);
    const score = termHits.length + (phraseHit ? Math.max(2, terms.length) : 0);
    if (score <= 0) {
      return;
    }
    matches.push({
      doc_id: doc.id,
      title: doc.title,
      uri: `uts://docs/${doc.id}`,
      line: index + 1,
      score,
      snippet: snippetForLine(line, [...termHits, lowerQuery], maxSnippetChars)
    });
  });
  return matches;
}

function selectedDocs(docIds: string[] | undefined): typeof DOCS[number][] {
  if (!docIds?.length) {
    return [...DOCS];
  }
  if (docIds.length > DOCS.length) {
    throw new Error(`docIds must contain at most ${DOCS.length} entries`);
  }
  const seen = new Set<string>();
  return docIds.map((docId) => {
    if (seen.has(docId)) {
      throw new Error("docIds must be unique");
    }
    seen.add(docId);
    return findDoc(docId);
  });
}

function findDoc(docId: string): typeof DOCS[number] {
  const doc = DOCS.find((candidate) => candidate.id === docId);
  if (!doc) {
    throw new Error(`Unknown documentation id: ${docId}`);
  }
  return doc;
}

function selectedRemoteSources(sourceIds: string[] | undefined): typeof REMOTE_DOC_SOURCES[number][] {
  if (!sourceIds?.length) {
    return [...REMOTE_DOC_SOURCES];
  }
  if (sourceIds.length > REMOTE_DOC_SOURCES.length) {
    throw new Error(`sourceIds must contain at most ${REMOTE_DOC_SOURCES.length} entries`);
  }
  const seen = new Set<string>();
  return sourceIds.map((sourceId) => {
    if (seen.has(sourceId)) {
      throw new Error("sourceIds must be unique");
    }
    seen.add(sourceId);
    return findRemoteDocSource(sourceId);
  });
}

function findRemoteDocSource(sourceId: string): typeof REMOTE_DOC_SOURCES[number] {
  const source = REMOTE_DOC_SOURCES.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new Error(`Unknown documentation source id: ${sourceId}`);
  }
  assertAllowedSourceUrl(source.url);
  return source;
}

async function refreshOneDocSource(
  source: typeof REMOTE_DOC_SOURCES[number],
  options: {
    cacheDir: string;
    fetcher: DocsFetcher;
    maxBytes: number;
    observedAt: string;
    timeoutMs: number;
    writeCache: boolean;
  }
): Promise<DocsRefreshSourceResult> {
  const cacheUri = `uts://docs-cache/${source.id}`;
  const warnings: string[] = [];
  try {
    const response = await options.fetcher(source.url, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes
    });
    const headers = normalizedHeaders(response.headers);
    const statusCode = response.status;
    const contentType = normalizedContentType(headers["content-type"]);
    assertAllowedFinalUrl(response.finalUrl ?? source.url, source.url);
    if (statusCode >= 300 && statusCode < 400) {
      throw new Error("redirect responses are not followed by docs.refresh");
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`documentation source returned HTTP ${statusCode}`);
    }
    if (!isAllowedContentType(contentType)) {
      throw new Error(`unsupported documentation content type: ${contentType}`);
    }
    const declaredLength = integerHeader(headers["content-length"]);
    if (declaredLength !== undefined && declaredLength > options.maxBytes) {
      throw new Error(`documentation response content-length exceeds maxBytes (${options.maxBytes})`);
    }
    const body = bodyBuffer(response.body);
    if (body.byteLength > options.maxBytes) {
      throw new Error(`documentation response body exceeds maxBytes (${options.maxBytes})`);
    }
    const rawText = body.toString("utf8").replace(/\0/g, "");
    const text = contentType === "text/html" || contentType === "application/xhtml+xml" ? htmlToText(rawText) : plainToText(rawText);
    if (text.length === 0) {
      warnings.push("Fetched documentation page produced empty text after sanitization");
    }
    const title = extractedTitle(rawText) || source.title;
    const contentHash = createHash("sha256").update(body).digest("hex");
    const record: DocsCacheRecord = {
      schema_version: "0.1.0",
      source_id: source.id,
      title,
      source_url: source.url,
      observed_at: options.observedAt,
      status_code: statusCode,
      content_type: contentType,
      bytes: body.byteLength,
      text_chars: text.length,
      content_hash: contentHash,
      ...(headers.etag ? { etag: headers.etag } : {}),
      ...(headers["last-modified"] ? { last_modified: headers["last-modified"] } : {}),
      text,
      warnings
    };
    assertDocsCacheRecord(record);
    if (options.writeCache) {
      writeCachedDoc(options.cacheDir, source.id, record);
    }
    return {
      source_id: source.id,
      title,
      source_url: source.url,
      cache_uri: cacheUri,
      status: "refreshed",
      observed_at: options.observedAt,
      status_code: statusCode,
      content_type: contentType,
      bytes: body.byteLength,
      text_chars: text.length,
      content_hash: contentHash,
      snippet: snippetForText(text, 240),
      warnings
    };
  } catch (error) {
    const sanitizedError = sanitizeErrorMessage(error);
    // Match genuine network failures only. Use "fetch failed" (the undici network-error message),
    // NOT a bare "fetch", so the redirect/host-guard messages ("Documentation fetch final URL ...")
    // do not spuriously trigger the offline-handoff note.
    if (/fetch failed|timeout|ECONNREFUSED|ENOTFOUND|ERR_NETWORK|EAI_AGAIN|getaddrinfo/i.test(sanitizedError)) {
      warnings.push(
        "Network error: if you can't reach the UTS network/VPN right now, run access.doctor --export-ssh to get the SSH access path (~/.ssh/config snippet + login_host + required env-var names) for a manual handoff."
      );
    }
    return {
      source_id: source.id,
      title: source.title,
      source_url: source.url,
      cache_uri: cacheUri,
      status: "failed",
      observed_at: options.observedAt,
      warnings,
      error: sanitizedError
    };
  }
}

async function defaultDocsFetcher(url: string, options: DocsFetcherOptions): Promise<DocsFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1",
        "User-Agent": "uts-compute-docs-refresh/0.1"
      }
    });
    const headers = normalizedHeaders(response.headers);
    const body = await readFetchBody(response, options.maxBytes);
    return {
      status: response.status,
      headers,
      body,
      finalUrl: response.url
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readFetchBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`documentation response body exceeds maxBytes (${maxBytes})`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function docsCacheDir(inputPath: string | undefined, create: boolean): string {
  const resolved = assertInsideRuntime(inputPath ?? DOCS_CACHE_DIR, "Documentation cache directory");
  if (create) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function docsCacheFilePath(cacheDir: string, sourceId: string): string {
  const filePath = path.join(cacheDir, `${sourceId}.json`);
  const relative = path.relative(cacheDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Documentation cache path must stay inside the cache directory");
  }
  return filePath;
}

function writeCachedDoc(cacheDir: string, sourceId: string, record: DocsCacheRecord): void {
  const filePath = docsCacheFilePath(cacheDir, sourceId);
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  assertRealPathInside(filePath, cacheDir, "Documentation cache file");
}


function assertAllowedSourceUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_REMOTE_HOSTS.has(url.hostname)) {
    throw new Error("Documentation source URL must be an allowlisted UTS HTTPS URL");
  }
}

function assertAllowedFinalUrl(value: string, sourceUrl: string): void {
  const finalUrl = new URL(value);
  const expected = new URL(sourceUrl);
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== expected.hostname) {
    throw new Error("Documentation fetch final URL must stay on the allowlisted source host");
  }
}

function normalizedHeaders(input: DocsFetchResponse["headers"]): Record<string, string> {
  if (!input) {
    return {};
  }
  if (typeof (input as Headers).forEach === "function") {
    const result: Record<string, string> = {};
    (input as Headers).forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key.toLowerCase(), value])
  );
}

function normalizedContentType(value: string | undefined): string {
  const contentType = value?.split(";")[0]?.trim().toLowerCase();
  return contentType || "text/html";
}

function isAllowedContentType(value: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(value);
}

function integerHeader(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bodyBuffer(value: DocsFetchResponse["body"]): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  return Buffer.from(value);
}

function htmlToText(value: string): string {
  return plainToText(
    decodeHtmlEntities(
      value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|section|article|li|tr|td|th|h[1-6]|br|table|ul|ol)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function plainToText(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function extractedTitle(value: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  if (!match?.[1]) {
    return null;
  }
  const title = plainToText(decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " "))).slice(0, 200);
  return title.length > 0 ? title : null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const parsed = Number.parseInt(code, 10);
      return safeCodePoint(parsed);
    })
    .replace(/&#x([a-f0-9]+);/gi, (_match, code: string) => {
      const parsed = Number.parseInt(code, 16);
      return safeCodePoint(parsed);
    });
}

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
}

function snippetForText(text: string, maxChars: number): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars)}...`;
}

// Standardized on the canonical <local-home> placeholder (was "/Users/<user>" here before the
// lib/redact consolidation — the one site that had drifted from the token every other redactor used).
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactLocalHome(redactProjectRoot(message, projectRoot));
}

function resolveDocPath(docPath: string): string {
  const resolved = assertInsideProject(docPath, "Documentation path");
  const realCandidate = fs.realpathSync(resolved);
  const realRoot = fs.realpathSync(projectRoot);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Documentation path must stay inside the project root");
  }
  return realCandidate;
}

function normalizeQuery(value: string): string {
  if (typeof value !== "string") {
    throw new Error("query must be a string");
  }
  const query = value.trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 200) {
    throw new Error("query must be between 2 and 200 characters");
  }
  if (/[\0\r\n]/.test(query)) {
    throw new Error("query must not contain control characters");
  }
  return query;
}

function searchTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.:-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms.length ? terms : [query.toLowerCase()])];
}

function snippetForLine(line: string, needles: string[], maxChars: number): string {
  const trimmed = line.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  const firstHit = needles
    .map((needle) => lower.indexOf(needle.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const center = firstHit ?? 0;
  const start = Math.max(0, Math.min(center - Math.floor(maxChars / 3), trimmed.length - maxChars));
  const end = Math.min(trimmed.length, start + maxChars);
  return `${start > 0 ? "..." : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "..." : ""}`;
}
