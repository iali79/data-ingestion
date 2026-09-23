import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync, createGunzip } from 'node:zlib';
import {
  TEXT_VERSION,
  downloadAndExtractDocument,
  type DocumentKind,
  type ExtractedDocument,
  type ExtractedPage,
  type OcrPolicy,
} from './extraction.js';
import { GithubReleases, type ReleaseAsset } from './github.js';

/**
 * The document corpus: the page text of every filing this extractor has read, kept as GitHub
 * release assets so a filing is downloaded and OCR'd once, ever. A parser change then re-reads
 * saved text instead of re-fetching PDFs and re-running OCR.
 *
 * Layout:
 *   release `corpus-index`, asset `index.json.gz`  -> key => where that record lives
 *   release `corpus-YYYY-MM-DD`, assets `corpus-<run>-<attempt>-<n>.jsonl.gz` -> one record per line
 *
 * Git history is never used: the text runs to gigabytes and history can't shrink.
 *
 * A record holds only what was downloaded from a public PSX URL and the text read from it --
 * never a task id, a lease token or anything from the ingest API beyond the ticker symbol.
 */
export const CORPUS_VERSION = 1;
export const INDEX_TAG = 'corpus-index';
export const INDEX_ASSET = 'index.json.gz';
export const INDEX_NEXT_ASSET = 'index-next.json.gz';

const KEY_PATTERN = /^[0-9a-f]{32}$/u;
const DOCUMENT_KINDS: ReadonlySet<DocumentKind> = new Set(['pdf', 'image', 'html', 'text', 'csv', 'spreadsheet']);

export interface CorpusRecord {
  key: string;
  corpusVersion: number;
  textVersion: number;
  sourceUrl: string;
  symbol: string | null;
  extractedAt: string;
  source: { byteLength: number; sha256: string } | null;
  document: {
    kind: DocumentKind;
    method: string;
    contentType: string | null;
    confidence: number;
    /** Present only when it differs from the pages joined with form feeds (spreadsheets). */
    text?: string;
    /** `skipped` when scanned pages were left un-OCR'd; absent on records made before it existed (all OCR'd). */
    ocr?: 'complete' | 'skipped';
    pages: ExtractedPage[];
  };
}

export interface IndexEntry {
  tag: string;
  asset: string;
  assetId: number;
  textVersion: number;
  extractedAt: string;
  symbol: string | null;
}

export interface CorpusIndex {
  corpusVersion: number;
  updatedAt: string;
  entries: Record<string, IndexEntry>;
}

/** Stable, URL-derived key. Same URL, same key, on every runner. */
export function corpusKey(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32);
}

export function toCorpusRecord(
  sourceUrl: string,
  document: ExtractedDocument,
  options: { symbol?: string | null; extractedAt?: Date } = {},
): CorpusRecord {
  const joined = document.pages.map((page) => page.text).join('\f');
  return {
    // `key` first: readers pick it out of each line before parsing the rest.
    key: corpusKey(sourceUrl),
    corpusVersion: CORPUS_VERSION,
    textVersion: TEXT_VERSION,
    sourceUrl,
    symbol: options.symbol ?? null,
    extractedAt: (options.extractedAt ?? new Date()).toISOString(),
    source: document.source ?? null,
    document: {
      kind: document.kind,
      method: document.method,
      contentType: document.contentType,
      confidence: document.confidence,
      ...(document.text === joined ? {} : { text: document.text }),
      ...(document.ocr ? { ocr: document.ocr } : {}),
      pages: document.pages.map(({ pageNumber, method, confidence, text }) => ({ pageNumber, method, confidence, text })),
    },
  };
}

/**
 * Checks a record's shape and returns it, or null. Records are read back from release assets,
 * so they are treated as data to validate, not trusted as-is.
 */
export function parseCorpusRecord(value: unknown): CorpusRecord | null {
  if (!isObject(value)) return null;
  const { key, corpusVersion, textVersion, sourceUrl, symbol, extractedAt, source, document } = value;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return null;
  if (corpusVersion !== CORPUS_VERSION || !Number.isInteger(textVersion)) return null;
  if (typeof sourceUrl !== 'string' || corpusKey(sourceUrl) !== key) return null;
  if (symbol !== null && typeof symbol !== 'string') return null;
  if (typeof extractedAt !== 'string' || Number.isNaN(Date.parse(extractedAt))) return null;
  if (source !== null && !(isObject(source) && typeof source.byteLength === 'number' && typeof source.sha256 === 'string')) return null;
  if (!isObject(document) || !DOCUMENT_KINDS.has(document.kind as DocumentKind)) return null;
  if (typeof document.method !== 'string' || typeof document.confidence !== 'number') return null;
  if (document.contentType !== null && typeof document.contentType !== 'string') return null;
  if (document.text !== undefined && typeof document.text !== 'string') return null;
  if (document.ocr !== undefined && document.ocr !== 'complete' && document.ocr !== 'skipped') return null;
  if (!Array.isArray(document.pages) || !document.pages.every(isPage)) return null;
  return value as unknown as CorpusRecord;
}

/** Rebuilds the extractor's document from a record, or null if it was made from another URL or text version. */
export function recordToDocument(record: CorpusRecord, sourceUrl: string): ExtractedDocument | null {
  if (record.sourceUrl !== sourceUrl || record.textVersion !== TEXT_VERSION) return null;
  const pages = record.document.pages.map((page) => ({ ...page }));
  return {
    kind: record.document.kind,
    method: record.document.method,
    contentType: record.document.contentType,
    confidence: record.document.confidence,
    text: record.document.text ?? pages.map((page) => page.text).join('\f'),
    pages,
    ocr: record.document.ocr ?? 'complete',
    ...(record.source ? { source: record.source } : {}),
  };
}

/** Adds entries to an index; for a key seen twice, the later extraction wins. */
export function mergeIndex(index: CorpusIndex, additions: Array<[string, IndexEntry]>, now = new Date()): CorpusIndex {
  const entries = { ...index.entries };
  for (const [key, entry] of additions) {
    const current = entries[key];
    if (!current || Date.parse(entry.extractedAt) >= Date.parse(current.extractedAt)) entries[key] = entry;
  }
  return { corpusVersion: CORPUS_VERSION, updatedAt: now.toISOString(), entries };
}

export function emptyIndex(): CorpusIndex {
  return { corpusVersion: CORPUS_VERSION, updatedAt: new Date(0).toISOString(), entries: {} };
}

export function parseIndex(value: unknown): CorpusIndex | null {
  if (!isObject(value) || value.corpusVersion !== CORPUS_VERSION || !isObject(value.entries)) return null;
  const entries: Record<string, IndexEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!KEY_PATTERN.test(key) || !isObject(entry)) continue;
    if (typeof entry.tag !== 'string' || typeof entry.asset !== 'string' || typeof entry.assetId !== 'number') continue;
    if (!Number.isInteger(entry.textVersion) || typeof entry.extractedAt !== 'string') continue;
    entries[key] = {
      tag: entry.tag,
      asset: entry.asset,
      assetId: entry.assetId,
      textVersion: entry.textVersion as number,
      extractedAt: entry.extractedAt,
      symbol: typeof entry.symbol === 'string' ? entry.symbol : null,
    };
  }
  return { corpusVersion: CORPUS_VERSION, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '', entries };
}

/**
 * Groups serialized records into release assets. Bounded by bytes so a cache hit never has to
 * download more than one modest file, and by count to keep a release's asset list short.
 */
export function chunkLines(lines: string[], maxBytes: number, maxCount: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (current.length > 0 && (bytes + size > maxBytes || current.length >= maxCount)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Loads the index from the `corpus-index` release; null when there is none yet. */
export async function loadIndex(releases: GithubReleases): Promise<{ index: CorpusIndex; assets: ReleaseAsset[] } | null> {
  const release = await releases.releaseByTag(INDEX_TAG);
  if (!release) return null;
  const assets = await releases.listAssets(release.id);
  // `index-next` survives only if a publish died between uploading it and renaming it.
  const asset = assets.find((item) => item.name === INDEX_ASSET) ?? assets.find((item) => item.name === INDEX_NEXT_ASSET);
  if (!asset) return { index: emptyIndex(), assets };
  const response = await releases.openAsset(asset.id);
  const index = parseIndex(JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')));
  if (!index) throw new Error('corpus index has an unexpected shape');
  return { index, assets };
}

export interface CorpusStats {
  hits: number;
  misses: number;
  saved: number;
}

/**
 * The extractor's view of the corpus: read saved text when it exists for this URL and text
 * version, otherwise download and extract, and save the result for the publish job to upload.
 * Nothing here can fail a task -- any corpus problem falls back to a fresh download.
 */
export class DocumentCorpus {
  readonly stats: CorpusStats = { hits: 0, misses: 0, saved: 0 };
  private readonly unpacked = new Map<number, Promise<void>>();
  private workDir: string | null = null;

  private constructor(
    private readonly options: { releases: GithubReleases | null; index: CorpusIndex; outDir: string | null },
  ) {}

  static async open(options: {
    repository?: string | null;
    token?: string | null;
    read: boolean;
    outDir?: string | null;
    log?: (message: string) => void;
  }): Promise<DocumentCorpus> {
    const log = options.log ?? (() => undefined);
    let releases: GithubReleases | null = null;
    let index = emptyIndex();
    if (options.read && options.repository) {
      releases = new GithubReleases(options.repository, options.token ?? null);
      try {
        index = (await loadIndex(releases))?.index ?? emptyIndex();
      } catch (error) {
        log(`corpus index unavailable, extracting everything fresh: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    if (options.outDir) await mkdir(options.outDir, { recursive: true });
    return new DocumentCorpus({ releases, index, outDir: options.outDir ?? null });
  }

  get size(): number {
    return Object.keys(this.options.index.entries).length;
  }

  async obtain(sourceUrl: string, meta: { symbol?: string | null } = {}, ocr: OcrPolicy = { mode: 'always' }): Promise<ExtractedDocument> {
    const saved = await this.load(sourceUrl).catch(() => null);
    // Saved text whose scanned pages were skipped is only good enough if this caller agrees they
    // are not needed; otherwise extract again, this time with OCR.
    const usable = saved && (saved.ocr !== 'skipped' || (ocr.mode === 'if-needed' && !ocr.needsOcr(saved)));
    if (saved && usable) {
      this.stats.hits += 1;
      return saved;
    }
    this.stats.misses += 1;
    const document = await downloadAndExtractDocument(sourceUrl, ocr);
    await this.save(sourceUrl, document, meta.symbol ?? null).catch(() => undefined);
    return document;
  }

  /** Saved text for this URL at the current text version, or null. */
  async load(sourceUrl: string): Promise<ExtractedDocument | null> {
    const key = corpusKey(sourceUrl);
    const entry = this.options.index.entries[key];
    if (!entry || entry.textVersion !== TEXT_VERSION || !this.options.releases) return null;
    const dir = await this.ensureWorkDir();
    await this.unpack(entry.assetId, dir);
    const raw = await readFile(path.join(dir, `${key}.json.gz`)).catch(() => null);
    if (!raw) return null;
    const record = parseCorpusRecord(JSON.parse(gunzipSync(raw).toString('utf8')));
    return record ? recordToDocument(record, sourceUrl) : null;
  }

  private async save(sourceUrl: string, document: ExtractedDocument, symbol: string | null): Promise<void> {
    if (!this.options.outDir) return;
    const record = toCorpusRecord(sourceUrl, document, { symbol });
    await writeFile(path.join(this.options.outDir, `${record.key}.json.gz`), gzipSync(JSON.stringify(record)));
    this.stats.saved += 1;
  }

  private async ensureWorkDir(): Promise<string> {
    this.workDir ??= await mkdtemp(path.join(tmpdir(), 'corpus-'));
    return this.workDir;
  }

  /**
   * Downloads one release asset once per job and splits it into per-record files, so later hits
   * in the same asset are local reads. Records stay gzipped on disk: a full corpus unpacked would
   * not fit on a runner.
   */
  private unpack(assetId: number, dir: string): Promise<void> {
    let pending = this.unpacked.get(assetId);
    if (!pending) {
      pending = (async () => {
        const response = await this.options.releases!.openAsset(assetId);
        if (!response.body) return;
        const lines = createInterface({
          input: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(createGunzip()),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          const key = /^\{"key":"([0-9a-f]{32})"/u.exec(line)?.[1];
          if (key) await writeFile(path.join(dir, `${key}.json.gz`), gzipSync(line));
        }
      })();
      // A failed download is retried on the next hit rather than cached as a failure.
      pending.catch(() => this.unpacked.delete(assetId));
      this.unpacked.set(assetId, pending);
    }
    return pending;
  }
}

/** Reads every `*.json.gz` record a job saved, dropping any that fail validation. */
export async function readSavedRecords(dir: string, files: string[]): Promise<{ records: CorpusRecord[]; invalid: number }> {
  const records: CorpusRecord[] = [];
  let invalid = 0;
  for (const file of files) {
    if (!/^[0-9a-f]{32}\.json\.gz$/u.test(file)) continue;
    const record = await new Promise<CorpusRecord | null>((resolve) => {
      const chunks: Buffer[] = [];
      createReadStream(path.join(dir, file))
        .pipe(createGunzip())
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', () => {
          try {
            resolve(parseCorpusRecord(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch {
            resolve(null);
          }
        })
        .on('error', () => resolve(null));
    });
    if (record && `${record.key}.json.gz` === file) records.push(record);
    else invalid += 1;
  }
  return { records, invalid };
}

function isPage(value: unknown): value is ExtractedPage {
  return (
    isObject(value) &&
    Number.isInteger(value.pageNumber) &&
    (value.pageNumber as number) >= 1 &&
    typeof value.method === 'string' &&
    typeof value.confidence === 'number' &&
    typeof value.text === 'string'
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
