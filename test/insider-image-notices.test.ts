import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layoutFromTsv } from '../src/extraction.js';
import { parseInsiderDisclosure, readDate, readableTableLine } from '../src/insider.js';
import { joinDocuments, noticePages } from '../src/process.js';
import type { ExtractedDocument } from '../src/extraction.js';

/**
 * Disclosures of interest filed as scanned pages (PSX's e-form, a GIF), and the parser fixes the
 * 2026-11-06 replay of 1,925 saved notices called for.
 *
 * The fixture is tesseract's real word-by-word reading (`--psm 11`, TSV) of one such notice
 * enlarged three times, with the company, people and phone numbers replaced by invented ones.
 * Read the old way the same notice gave the parser nothing.
 */
const TSV = readFileSync(new URL('./fixtures/insider/pucars-282647-3x-psm11.tsv', import.meta.url), 'utf8');

describe('a disclosure filed as an image', () => {
  it('reads every field of its row once the lines are rebuilt from the word boxes', () => {
    const { text, confidence } = layoutFromTsv(TSV);
    expect(confidence).toBeGreaterThan(0.5);
    const rows = parseInsiderDisclosure(text, { publishedAt: new Date('2026-09-14T09:51:00Z'), ocr: true });
    expect(rows).toEqual([
      expect.objectContaining({
        date: '2026-09-08',
        person: 'ZARINAA SAMPLE',
        designation: 'Substantial Shareholder',
        nature: 'buy',
        quantity: 4_000_000,
        rate: 2.55,
        market: 'NDM',
        cumulativeShares: 39_466_500,
        cumulativePercent: 22.9,
      }),
    ]);
  });

  it('keeps the words of a line in order across the page', () => {
    const { text } = layoutFromTsv(TSV);
    const row = text.split('\n').find((line) => line.includes('2026-09-08'))!;
    expect(row.indexOf('CDC')).toBeLessThan(row.indexOf('NDM'));
    expect(row.indexOf('NDM')).toBeLessThan(row.indexOf('2026-09-08'));
    expect(row.indexOf('4000000')).toBeLessThan(row.indexOf('39466500'));
    expect(text).toContain('Subject: DISCLOSURE OF INTEREST');
  });

  it('gives nothing for an empty or wordless reading', () => {
    expect(layoutFromTsv('level\tpage_num\n')).toEqual({ text: '', confidence: 0.2 });
  });
});

describe('readableTableLine', () => {
  it('turns the table rules OCR reads into spaces of the same width, so columns stay put', () => {
    const line = '[1 | Muhammad Example [coc | Ready [ 13-12-2024 | Buy [2,500] 286 |';
    const out = readableTableLine(line);
    expect(out).not.toMatch(/[|[\]]/u);
    expect(out.indexOf('Buy')).toBe(line.indexOf('Buy'));
  });

  it('separates a nature word that OCR ran into the date before it', () => {
    expect(readableTableLine('2026-09-08BUY  4000000')).toBe('2026-09-08 BUY  4000000');
    expect(readableTableLine('2026-09-08Sell 10')).toBe('2026-09-08 Sell 10');
    // Only a nature word: a figure followed by letters is left as it is.
    expect(readableTableLine('5.6.4th BUYER')).toBe('5.6.4th BUYER');
  });

  it('is applied to OCR text only: a text PDF keeps its own brackets', () => {
    const text = `Name  Date  Nature  No. of Shares  Rate
AGT Holdings (Pvt.) Limited [formerly AGT Holdings]   31-12-2025   Buy   218   4,189.00
Yours sincerely`;
    const [row] = parseInsiderDisclosure(text, { publishedAt: new Date('2026-01-02T00:00:00Z') });
    expect(row?.quantity).toBe(218);
  });
});

describe('readDate', () => {
  it('reads a date with one stray space beside a separator', () => {
    expect(readDate('21 -05-2025')).toBe('2025-05-21');
    expect(readDate('21- 05-2025')).toBe('2025-05-21');
  });

  it('does not join a row number to the date after it', () => {
    expect(readDate('1.                 09-05-2024')).toBe('2024-05-09');
  });
});

describe('names', () => {
  it('drops a quantity printed in the name column', () => {
    const text = `S. No.   Name   No. of Shares   Nature of Transaction   Rate per share (Rs.)   Date
     1    Khalid Example Qazi           731        Buy         128.00     14.11.2024    Electronically - CDC
We further confirm`;
    const [row] = parseInsiderDisclosure(text, { publishedAt: new Date('2024-11-15T00:00:00Z') });
    expect(row).toMatchObject({ person: 'Khalid Example Qazi', quantity: 731, rate: 128, date: '2024-11-14' });
  });

  it('drops OCR\'s misreading of CDC from a name', () => {
    const [row] = parseInsiderDisclosure('Name  Form  Market  Date  Nature  Shares  Rate  Cumulative\n 1   Muhammadexample   coc   Ready   13-12-2024   Buy   2,500   286.00   2,500\nRegards', {
      publishedAt: new Date('2024-12-16T00:00:00Z'),
      ocr: true,
    });
    expect(row?.person).toBe('Muhammadexample');
  });
});

describe('notice pages', () => {
  const page = (text: string): ExtractedDocument => ({
    kind: 'image',
    method: 'tesseract-layout-3x',
    contentType: 'image/gif',
    text,
    confidence: 0.9,
    pages: [{ pageNumber: 1, method: 'tesseract', text, confidence: 0.9 }],
  });

  it('reads every image page of a notice, starting with its own first page', () => {
    const first = 'https://dps.psx.com.pk/download/image/300001-1.gif';
    const second = 'https://dps.psx.com.pk/download/image/300001-2.gif';
    expect(noticePages(first, [first, second])).toEqual([first, second]);
    expect(noticePages(first, undefined)).toEqual([first]);
    expect(noticePages(first, [first])).toEqual([first]);
    // A list that does not begin with the notice's own page is not trusted.
    expect(noticePages(first, [second, first])).toEqual([first]);
  });

  it('joins the pages into one document, numbered in order', () => {
    const joined = joinDocuments([page('one'), page('two')]);
    expect(joined.text).toBe('one\ftwo');
    expect(joined.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
  });
});
