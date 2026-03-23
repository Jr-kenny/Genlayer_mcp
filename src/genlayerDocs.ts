import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DOCS_URL = "https://docs.genlayer.com/full-documentation.txt";
const DEFAULT_CACHE_FILE = path.join(process.cwd(), ".cache", "genlayer-full-documentation.txt");
const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_TIMEOUT_MS = 15000;

export interface DocSection {
  body: string;
  path: string;
  publicUrl: string;
  slug: string;
  summary: string;
  title: string;
  uri: string;
}

export interface DocsSnapshot {
  fetchedAt: string;
  sections: DocSection[];
  source: string;
}

interface ServiceOptions {
  cacheFile?: string;
  docsSource?: string;
  refreshHours?: number;
  timeoutMs?: number;
}

interface SearchResult {
  score: number;
  section: DocSection;
  snippet: string;
}

export interface TopicSummary {
  count: number;
  key: string;
  label: string;
  sampleSections: DocSection[];
}

export class GenlayerDocsService {
  private readonly cacheFile: string;
  private readonly docsSource: string;
  private readonly refreshHours: number;
  private readonly timeoutMs: number;
  private loadPromise: Promise<DocsSnapshot> | undefined;
  private snapshot: DocsSnapshot | undefined;

  constructor(options: ServiceOptions = {}) {
    this.cacheFile = options.cacheFile ?? process.env.GENLAYER_DOCS_CACHE_FILE ?? DEFAULT_CACHE_FILE;
    this.docsSource = options.docsSource ?? process.env.GENLAYER_DOCS_URL ?? DEFAULT_DOCS_URL;
    this.refreshHours = options.refreshHours ?? readNumber(process.env.GENLAYER_DOCS_REFRESH_HOURS, DEFAULT_REFRESH_HOURS);
    this.timeoutMs = options.timeoutMs ?? readNumber(process.env.GENLAYER_DOCS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  }

  async getSnapshot(forceRefresh = false): Promise<DocsSnapshot> {
    if (this.snapshot && !forceRefresh) {
      return this.snapshot;
    }

    if (!this.loadPromise || forceRefresh) {
      const load = this.loadSnapshot();
      this.loadPromise = load.finally(() => {
        if (this.loadPromise === load) {
          this.loadPromise = undefined;
        }
      });
    }

    this.snapshot = await this.loadPromise;
    return this.snapshot;
  }

  async listSections(prefix?: string, limit = 50): Promise<DocSection[]> {
    const snapshot = await this.getSnapshot();
    const normalizedPrefix = normalize(prefix ?? "");

    const sections = normalizedPrefix
      ? snapshot.sections.filter((section) => {
          const haystack = `${section.slug} ${section.path} ${section.title}`.toLowerCase();
          return haystack.includes(normalizedPrefix);
        })
      : snapshot.sections;

    return sections.slice(0, limit);
  }

  async readSection(query: string): Promise<DocSection | undefined> {
    const snapshot = await this.getSnapshot();
    const normalizedQuery = normalize(query);

    const exactMatch = snapshot.sections.find((section) => {
      return [
        section.slug,
        section.path,
        section.title,
        section.publicUrl
      ].map(normalize).includes(normalizedQuery);
    });

    if (exactMatch) {
      return exactMatch;
    }

    return this.searchSnapshot(snapshot, query, 1)[0]?.section;
  }

  async getSectionBySlug(input: string): Promise<DocSection | undefined> {
    const snapshot = await this.getSnapshot();
    const slug = cleanSlug(input);

    if (!slug) {
      return undefined;
    }

    return snapshot.sections.find((section) => {
      return section.slug === slug || section.path === slug || section.path === `${slug}.mdx`;
    });
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const snapshot = await this.getSnapshot();
    return this.searchSnapshot(snapshot, query, limit);
  }

  async searchExamples(query: string, limit = 5): Promise<SearchResult[]> {
    const snapshot = await this.getSnapshot();
    const normalizedQuery = normalize(query);
    const tokens = tokenize(normalizedQuery);

    return snapshot.sections
      .filter((section) => sectionContainsExamples(section))
      .map((section) => {
        const title = normalize(section.title);
        const pathValue = normalize(section.path);
        const slug = normalize(section.slug);
        const body = normalize(section.body);

        let score = 0;
        if (title.includes(normalizedQuery)) {
          score += 30;
        }
        if (slug.includes(normalizedQuery) || pathValue.includes(normalizedQuery)) {
          score += 20;
        }
        if (body.includes(normalizedQuery)) {
          score += 12;
        }

        for (const token of tokens) {
          if (title.includes(token)) {
            score += 8;
          }
          if (slug.includes(token) || pathValue.includes(token)) {
            score += 5;
          }
          score += Math.min(countOccurrences(body, token), 4);
        }

        score += exampleSignals(section.body);

        if (score === 0) {
          return undefined;
        }

        return {
          score,
          section,
          snippet: makeSnippet(section, tokens, normalizedQuery)
        };
      })
      .filter((result): result is SearchResult => Boolean(result))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.section.title.localeCompare(right.section.title);
      })
      .slice(0, limit);
  }

  async getRelatedDocs(input: string, limit = 5): Promise<{ base: DocSection; results: SearchResult[] } | undefined> {
    const snapshot = await this.getSnapshot();
    const base = await this.getSectionBySlug(input) ?? await this.readSection(input);

    if (!base) {
      return undefined;
    }

    const baseTokens = tokenize(normalize(`${base.title} ${base.slug}`));
    const baseSegments = base.slug.split("/").filter(Boolean);
    const baseParent = baseSegments.slice(0, -1).join("/");

    const results = snapshot.sections
      .filter((section) => section.slug !== base.slug)
      .map((section) => {
        let score = 0;
        const sectionTokens = tokenize(normalize(`${section.title} ${section.slug}`));
        const sectionSegments = section.slug.split("/").filter(Boolean);
        const sectionParent = sectionSegments.slice(0, -1).join("/");

        if (baseParent && sectionParent === baseParent) {
          score += 35;
        }

        const commonPrefixLength = countCommonPrefix(baseSegments, sectionSegments);
        score += commonPrefixLength * 10;

        for (const token of baseTokens) {
          if (sectionTokens.includes(token)) {
            score += 5;
          }
        }

        if (base.path.split("/")[0] === section.path.split("/")[0]) {
          score += 8;
        }

        if (score === 0) {
          return undefined;
        }

        return {
          score,
          section,
          snippet: section.summary
        };
      })
      .filter((result): result is SearchResult => Boolean(result))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.section.title.localeCompare(right.section.title);
      })
      .slice(0, limit);

    return {
      base,
      results
    };
  }

  async listTopics(limit = 20): Promise<TopicSummary[]> {
    const snapshot = await this.getSnapshot();
    const topics = new Map<string, TopicSummary>();

    for (const section of snapshot.sections) {
      const key = section.slug.split("/").filter(Boolean)[0] ?? "overview";
      const existing = topics.get(key);

      if (existing) {
        existing.count += 1;
        if (existing.sampleSections.length < 3) {
          existing.sampleSections.push(section);
        }
        continue;
      }

      topics.set(key, {
        count: 1,
        key,
        label: topicLabel(key),
        sampleSections: [section]
      });
    }

    return Array.from(topics.values())
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }

        return left.label.localeCompare(right.label);
      })
      .slice(0, limit);
  }

  private async loadSnapshot(): Promise<DocsSnapshot> {
    const rawText = await this.loadRawBundle();
    const fetchedAt = new Date().toISOString();

    return {
      fetchedAt,
      sections: parseDocsBundle(rawText),
      source: this.docsSource
    };
  }

  private async loadRawBundle(): Promise<string> {
    const cache = await readCacheFile(this.cacheFile);
    if (cache && isFresh(cache.updatedAtMs, this.refreshHours)) {
      return cache.text;
    }

    try {
      const freshText = await readSourceText(this.docsSource, this.timeoutMs);
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.writeFile(this.cacheFile, freshText, "utf8");
      return freshText;
    } catch (error) {
      if (cache) {
        return cache.text;
      }

      const details = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load GenLayer documentation from ${this.docsSource}: ${details}`);
    }
  }

  private searchSnapshot(snapshot: DocsSnapshot, query: string, limit: number): SearchResult[] {
    const normalizedQuery = normalize(query);
    const tokens = tokenize(normalizedQuery);

    return snapshot.sections
      .map((section) => {
        const title = normalize(section.title);
        const pathValue = normalize(section.path);
        const slug = normalize(section.slug);
        const body = normalize(section.body);

        let score = 0;
        if (title.includes(normalizedQuery)) {
          score += 40;
        }
        if (slug.includes(normalizedQuery) || pathValue.includes(normalizedQuery)) {
          score += 25;
        }
        if (body.includes(normalizedQuery)) {
          score += 15;
        }

        for (const token of tokens) {
          if (title.includes(token)) {
            score += 10;
          }
          if (slug.includes(token) || pathValue.includes(token)) {
            score += 6;
          }

          const matches = countOccurrences(body, token);
          score += Math.min(matches, 5);
        }

        if (score === 0) {
          return undefined;
        }

        return {
          score,
          section,
          snippet: makeSnippet(section, tokens, normalizedQuery)
        };
      })
      .filter((result): result is SearchResult => Boolean(result))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.section.title.localeCompare(right.section.title);
      })
      .slice(0, limit);
  }
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No GenLayer documentation matches found for "${query}".`;
  }

  const lines = [`Top GenLayer documentation matches for "${query}":`, ""];

  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.section.title}`);
    lines.push(`   Path: ${result.section.path}`);
    lines.push(`   URI: ${result.section.uri}`);
    lines.push(`   URL: ${result.section.publicUrl}`);
    lines.push(`   Snippet: ${result.snippet}`);
  });

  return lines.join("\n");
}

export function formatSection(section: DocSection, maxChars = 6000): string {
  const header = [
    `${section.title}`,
    `Path: ${section.path}`,
    `URI: ${section.uri}`,
    `URL: ${section.publicUrl}`,
    ""
  ].join("\n");

  const budget = Math.max(maxChars - header.length, 400);
  const body = section.body.length > budget ? `${section.body.slice(0, budget).trimEnd()}\n\n[truncated]` : section.body;
  return `${header}${body}`.trimEnd();
}

export function formatRelatedDocs(base: DocSection, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No related GenLayer documentation was found for "${base.title}".`;
  }

  const lines = [
    `Related GenLayer documentation for "${base.title}":`,
    `Base: ${base.path}`,
    ""
  ];

  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.section.title}`);
    lines.push(`   Path: ${result.section.path}`);
    lines.push(`   URI: ${result.section.uri}`);
    lines.push(`   URL: ${result.section.publicUrl}`);
    lines.push(`   Why: ${result.snippet}`);
  });

  return lines.join("\n");
}

export function formatTopics(topics: TopicSummary[]): string {
  if (topics.length === 0) {
    return "No GenLayer documentation topics are currently available.";
  }

  const lines = ["GenLayer documentation topics:", ""];

  topics.forEach((topic, index) => {
    lines.push(`${index + 1}. ${topic.label} (${topic.count} sections)`);
    lines.push(`   Key: ${topic.key}`);
    lines.push(`   Examples: ${topic.sampleSections.map((section) => section.title).join(" | ")}`);
  });

  return lines.join("\n");
}

export function buildIndexDocument(snapshot: DocsSnapshot): string {
  return JSON.stringify(
    {
      fetchedAt: snapshot.fetchedAt,
      source: snapshot.source,
      sections: snapshot.sections.map((section) => ({
        path: section.path,
        publicUrl: section.publicUrl,
        slug: section.slug,
        summary: section.summary,
        title: section.title,
        uri: section.uri
      }))
    },
    null,
    2
  );
}

export function buildResourceList(sections: DocSection[]) {
  return sections.map((section) => ({
    name: section.slug,
    uri: section.uri,
    title: section.title,
    description: section.summary,
    mimeType: "text/markdown"
  }));
}

function parseDocsBundle(rawText: string): DocSection[] {
  const marker = /^#\s+([^\n]+\.mdx)\s*$/gm;
  const matches = Array.from(rawText.matchAll(marker));
  const sections: DocSection[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) {
      continue;
    }

    const pathValue = match[1]?.trim();
    const start = match.index ?? 0;
    const bodyStart = start + match[0].length;
    const nextMatch = matches[index + 1];
    const end = nextMatch?.index ?? rawText.length;

    if (!pathValue) {
      continue;
    }

    const body = rawText.slice(bodyStart, end).trim();
    const slug = pathValue.replace(/\.mdx$/i, "").replace(/^\/+/, "");
    const title = extractTitle(body) ?? titleFromPath(slug);
    const summary = extractSummary(body);

    sections.push({
      body,
      path: pathValue,
      publicUrl: toPublicDocUrl(slug),
      slug,
      summary,
      title,
      uri: `genlayer://docs/section/${encodeURIComponent(slug)}`
    });
  }

  return sections;
}

function extractSummary(body: string): string {
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("import ") || trimmed.startsWith("<") || trimmed.startsWith("#")) {
      continue;
    }

    return stripMarkdown(trimmed).slice(0, 220);
  }

  return "No summary available.";
}

function extractTitle(body: string): string | undefined {
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      return stripMarkdown(trimmed.replace(/^#{1,6}\s+/, "")).trim();
    }
  }

  return undefined;
}

function makeSnippet(section: DocSection, tokens: string[], normalizedQuery: string): string {
  const lines = section.body
    .split(/\r?\n/)
    .map((line) => stripMarkdown(line).trim())
    .filter(Boolean);

  const matchLine = lines.find((line) => {
    const normalizedLine = normalize(line);
    return normalizedLine.includes(normalizedQuery) || tokens.some((token) => normalizedLine.includes(token));
  });

  const source = matchLine ?? section.summary;
  return source.length > 220 ? `${source.slice(0, 217).trimEnd()}...` : source;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromPath(slug: string): string {
  const lastSegment = slug.split("/").filter(Boolean).at(-1) ?? slug;
  return lastSegment
    .split("-")
    .map((part) => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/]+/g, " ").replace(/\s+/g, " ").trim();
}

function cleanSlug(input: string): string {
  const value = input.trim();
  if (!value) {
    return "";
  }

  try {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const url = new URL(value);
      return url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    }
  } catch {
    // Keep falling through to plain-text cleanup.
  }

  return decodeURIComponent(value)
    .replace(/^genlayer:\/\/docs\/section\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.mdx$/i, "");
}

function tokenize(value: string): string[] {
  return Array.from(new Set(value.split(/\s+/).filter((part) => part.length >= 2)));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let start = 0;

  while (start >= 0) {
    start = haystack.indexOf(needle, start);
    if (start >= 0) {
      count += 1;
      start += needle.length;
    }
  }

  return count;
}

function sectionContainsExamples(section: DocSection): boolean {
  return exampleSignals(section.body) > 0;
}

function exampleSignals(body: string): number {
  let score = 0;

  if (body.includes("```")) {
    score += 10;
  }
  if (/\b(npm|pnpm|yarn|npx|pip|genlayer|curl)\b/i.test(body)) {
    score += 6;
  }
  if (/\b(json-rpc|rpc|api|sdk|cli|example|deploy|install|command)\b/i.test(body)) {
    score += 4;
  }

  return score;
}

function countCommonPrefix(left: string[], right: string[]): number {
  let count = 0;
  const max = Math.min(left.length, right.length);

  while (count < max && left[count] === right[count]) {
    count += 1;
  }

  return count;
}

function topicLabel(key: string): string {
  if (key === "index") {
    return "Overview";
  }

  return key
    .split("-")
    .map((part) => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function toPublicDocUrl(slug: string): string {
  if (!slug || slug === "index") {
    return "https://docs.genlayer.com/";
  }

  return `https://docs.genlayer.com/${slug}`;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readCacheFile(cacheFile: string): Promise<{ text: string; updatedAtMs: number } | undefined> {
  try {
    const [text, stats] = await Promise.all([
      fs.readFile(cacheFile, "utf8"),
      fs.stat(cacheFile)
    ]);

    return {
      text,
      updatedAtMs: stats.mtimeMs
    };
  } catch {
    return undefined;
  }
}

function isFresh(updatedAtMs: number, refreshHours: number): boolean {
  const maxAgeMs = refreshHours * 60 * 60 * 1000;
  return Date.now() - updatedAtMs <= maxAgeMs;
}

async function readSourceText(source: string, timeoutMs: number): Promise<string> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return readHttpSource(source, timeoutMs);
  }

  if (source.startsWith("file://")) {
    return fs.readFile(fileURLToPath(source), "utf8");
  }

  return fs.readFile(source, "utf8");
}

async function readHttpSource(source: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}
