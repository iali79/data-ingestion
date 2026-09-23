import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  chunkLines,
  corpusKey,
  emptyIndex,
  mergeIndex,
  parseCorpusRecord,
  parseIndex,
  readSavedRecords,
  recordToDocument,
  toCorpusRecord,
  type IndexEntry,
} from '../src/corpus.js';
import { TEXT_VERSION, type ExtractedDocument } from '../src/extraction.js';

const URL_A = 'https://financials.psx.com.pk/lib/DownloadPDF.php?id=272758';

function pdfDocument(): ExtractedDocument {
  const pages = [
    { pageNumber: 1, method: 'pdftotext', text: 'Statement of Profit or Loss\nRevenue 1,000', confidence: 0.85 },
    { pageNumber: 2, method: 'tesseract', text: 'Balance sheet\nTotal assets 5,000', confidence: 0.71 },
  ];
  return {
    kind: 'pdf',
    method: 'pdftotext+tesseract',
    contentType: 'application/pdf',
    text: pages.map((page) => page.text).join('\f'),
    confidence: 0.78,
    pages,
    source: { byteLength: 1234, sha256: 'a'.repeat(64) },
  };
}

function entry(extractedAt: string, asset = 'corpus-1-1-1.jsonl.gz'): IndexEntry {
  return { tag: 'corpus-2026-09-23', asset, assetId: 7, textVersion: TEXT_VERSION, extractedAt, symbol: 'HPL' };
}

describe('corpus records', () => {
  it('keys a document by its URL, stably', () => {
    expect(corpusKey(URL_A)).toMatch(/^[0-9a-f]{32}$/u);
    expect(corpusKey(URL_A)).toBe(corpusKey(URL_A));
    expect(corpusKey(`${URL_A}0`)).not.toBe(corpusKey(URL_A));
  });

  it('round-trips a PDF without storing the joined text twice', () => {
    const record = toCorpusRecord(URL_A, pdfDocument(), { symbol: 'HPL' });
    expect(record.document.text).toBeUndefined();
    expect(Object.keys(record)[0]).toBe('key');

    const parsed = parseCorpusRecord(JSON.parse(JSON.stringify(record)));
    expect(parsed).not.toBeNull();
    const document = recordToDocument(parsed!, URL_A);
    // Records made before the OCR flag existed were always fully OCR'd.
    expect(document).toEqual({ ...pdfDocument(), ocr: 'complete' });
  });

  it('keeps text that is not just the pages joined (spreadsheets)', () => {
    const sheet: ExtractedDocument = {
      kind: 'spreadsheet',
      method: 'xlsx',
      contentType: null,
      text: '# Sheet1\na,b',
      confidence: 0.9,
      pages: [{ pageNumber: 1, method: 'xlsx', text: 'a,b', confidence: 0.9 }],
    };
    const record = toCorpusRecord(URL_A, sheet);
    expect(record.document.text).toBe('# Sheet1\na,b');
    expect(recordToDocument(parseCorpusRecord(JSON.parse(JSON.stringify(record)))!, URL_A)?.text).toBe('# Sheet1\na,b');
  });

  it('never carries task or lease details', () => {
    const serialized = JSON.stringify(toCorpusRecord(URL_A, pdfDocument(), { symbol: 'HPL' }));
    expect(serialized).not.toMatch(/lease|taskId|token/iu);
  });

  it('rejects a record whose key does not match its URL', () => {
    const record = toCorpusRecord(URL_A, pdfDocument());
    expect(parseCorpusRecord({ ...record, sourceUrl: 'https://financials.psx.com.pk/lib/DownloadPDF.php?id=1' })).toBeNull();
  });

  it('rejects malformed pages and unknown document kinds', () => {
    const record = toCorpusRecord(URL_A, pdfDocument());
    expect(parseCorpusRecord({ ...record, document: { ...record.document, kind: 'exe' } })).toBeNull();
    expect(
      parseCorpusRecord({ ...record, document: { ...record.document, pages: [{ pageNumber: 0, method: 'x', confidence: 1, text: '' }] } }),
    ).toBeNull();
    expect(parseCorpusRecord(null)).toBeNull();
  });

  it('does not reuse text for a different URL or an older text version', () => {
    const record = toCorpusRecord(URL_A, pdfDocument());
    expect(recordToDocument(record, `${URL_A}0`)).toBeNull();
    expect(recordToDocument({ ...record, textVersion: TEXT_VERSION - 1 }, URL_A)).toBeNull();
  });
});

describe('corpus index', () => {
  it('lets the later extraction of a document win', () => {
    const key = corpusKey(URL_A);
    let index = mergeIndex(emptyIndex(), [[key, entry('2026-09-23T10:00:00.000Z', 'old.jsonl.gz')]]);
    index = mergeIndex(index, [[key, entry('2026-09-22T10:00:00.000Z', 'older.jsonl.gz')]]);
    expect(index.entries[key]?.asset).toBe('old.jsonl.gz');
    index = mergeIndex(index, [[key, entry('2026-09-24T10:00:00.000Z', 'new.jsonl.gz')]]);
    expect(index.entries[key]?.asset).toBe('new.jsonl.gz');
  });

  it('drops malformed entries when parsing', () => {
    const key = corpusKey(URL_A);
    const parsed = parseIndex({
      corpusVersion: 1,
      updatedAt: 'x',
      entries: { [key]: entry('2026-09-23T10:00:00.000Z'), 'not-a-key': entry('2026-09-23T10:00:00.000Z'), [corpusKey('b')]: { tag: 1 } },
    });
    expect(Object.keys(parsed!.entries)).toEqual([key]);
    expect(parseIndex({ corpusVersion: 2, entries: {} })).toBeNull();
  });
});

describe('chunking', () => {
  it('splits by count and by bytes, keeping order', () => {
    expect(chunkLines(['a', 'b', 'c'], 1_000, 2)).toEqual([['a', 'b'], ['c']]);
    expect(chunkLines(['aaaa', 'bbbb', 'cc'], 8, 10)).toEqual([['aaaa'], ['bbbb', 'cc']]);
    expect(chunkLines(['a-line-longer-than-the-cap'], 4, 10)).toEqual([['a-line-longer-than-the-cap']]);
    expect(chunkLines([], 10, 10)).toEqual([]);
  });
});

describe('saved records', () => {
  it('reads valid records and counts the rest as invalid', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'corpus-test-'));
    const record = toCorpusRecord(URL_A, pdfDocument());
    await writeFile(path.join(dir, `${record.key}.json.gz`), gzipSync(JSON.stringify(record)));
    const wrongName = 'f'.repeat(32);
    await writeFile(path.join(dir, `${wrongName}.json.gz`), gzipSync(JSON.stringify(record)));
    await writeFile(path.join(dir, `${'e'.repeat(32)}.json.gz`), Buffer.from('not gzip'));
    await writeFile(path.join(dir, 'README.txt'), 'ignored');

    const { records, invalid } = await readSavedRecords(dir, [
      `${record.key}.json.gz`,
      `${wrongName}.json.gz`,
      `${'e'.repeat(32)}.json.gz`,
      'README.txt',
    ]);
    expect(records.map((item) => item.key)).toEqual([record.key]);
    expect(invalid).toBe(2);
  });
});
