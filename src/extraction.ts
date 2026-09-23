import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { DocumentExtractionError } from './errors.js';
import { fetchDocument } from './http.js';

export type DocumentKind = 'pdf' | 'image' | 'html' | 'text' | 'csv' | 'spreadsheet' | 'unsupported';

export interface ExtractedPage {
  pageNumber: number;
  method: string;
  text: string;
  confidence: number;
}

export interface ExtractedDocument {
  kind: DocumentKind;
  method: string;
  contentType: string | null;
  text: string;
  confidence: number;
  pages: ExtractedPage[];
  /** The downloaded bytes this text came from; absent when extracted from a buffer directly. */
  source?: { byteLength: number; sha256: string };
}

/**
 * Version of the page text this module produces. Bump it whenever the text for the same document
 * would change -- OCR resolution, tesseract mode, the sparse-page threshold -- so text saved in the
 * document corpus under an older version is extracted again instead of reused.
 */
export const TEXT_VERSION = 1;

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
/** A page with less native text than this is treated as a scan and sent to OCR. */
const SPARSE_PAGE_CHARS = 80;

export async function downloadAndExtractDocument(url: string): Promise<ExtractedDocument> {
  const response = await fetchDocument(url);
  const contentType = response.headers.get('content-type');
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    throw new DocumentExtractionError('document_too_large', `document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const buffer = await readResponseWithLimit(response, MAX_DOCUMENT_BYTES);
  const document = await extractDocument(buffer, { url, contentType });
  document.source = { byteLength: buffer.byteLength, sha256: createHash('sha256').update(buffer).digest('hex') };
  return document;
}

export async function extractDocument(
  buffer: Buffer,
  options: { url?: string; contentType?: string | null },
): Promise<ExtractedDocument> {
  const kind = detectDocumentKind(buffer, options);
  if (kind === 'unsupported') {
    throw new DocumentExtractionError('unsupported_type', 'unsupported document type');
  }
  if (kind === 'pdf') return extractPdf(buffer, options.contentType ?? null);
  if (kind === 'image') return extractImage(buffer, extensionForKind(kind, options.url), options.contentType ?? null);
  if (kind === 'spreadsheet') return extractSpreadsheet(buffer, options.contentType ?? null);

  const decoded = buffer.toString('utf8');
  const text = kind === 'html' ? htmlToText(decoded) : decoded;
  const confidence = text.trim().length > 0 ? 0.8 : 0.2;
  return {
    kind,
    method: kind,
    contentType: options.contentType ?? null,
    text,
    confidence,
    pages: [{ pageNumber: 1, method: kind, text, confidence }],
  };
}

export function detectDocumentKind(
  buffer: Buffer,
  options: { url?: string; contentType?: string | null } = {},
): DocumentKind {
  const type = (options.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = (options.url ? path.extname(new URL(options.url, 'https://local.invalid').pathname) : '').toLowerCase();
  const head = buffer.subarray(0, 12);

  if (head.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image';
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image';
  if (head.subarray(0, 4).toString('ascii') === 'GIF8') return 'image';
  if (head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))) return 'image';
  if (head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return 'image';
  if (head.subarray(0, 2).toString('ascii') === 'BM') return 'image';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image';
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return ext === '.xlsx' || type.includes('spreadsheet') || buffer.includes(Buffer.from('xl/'))
      ? 'spreadsheet'
      : 'unsupported';
  }
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return ext === '.xls' || type.includes('excel') ? 'spreadsheet' : 'unsupported';
  }

  if (type === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (type.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.tif', '.tiff'].includes(ext)) return 'image';
  if (type.includes('spreadsheet') || type.includes('excel') || ['.xls', '.xlsx'].includes(ext)) return 'spreadsheet';
  if (type === 'text/csv' || ext === '.csv') return 'csv';
  if (type === 'text/plain' || ext === '.txt') return 'text';
  if (type === 'text/html' || ext === '.html' || ext === '.htm' || looksLikeHtml(buffer)) return 'html';
  return 'unsupported';
}

async function extractPdf(buffer: Buffer, contentType: string | null): Promise<ExtractedDocument> {
  const dir = await mkdtemp(path.join(tmpdir(), 'report-'));
  try {
    const pdf = path.join(dir, 'source.pdf');
    await writeFile(pdf, buffer);
    const native = await runCommand('pdftotext', ['-layout', pdf, '-']);
    const nativePages = native.stdout.split(/\f/u);
    if (nativePages.at(-1)?.trim() === '') nativePages.pop();
    const pages: ExtractedPage[] = nativePages.map((text, index) => {
      const dense = text.trim().length >= SPARSE_PAGE_CHARS;
      return { pageNumber: index + 1, method: dense ? 'pdftotext' : 'sparse', text, confidence: dense ? 0.85 : 0.35 };
    });

    const sparse = pages.filter((page) => page.text.trim().length < SPARSE_PAGE_CHARS);
    if (sparse.length > 0 && (await commandAvailable('tesseract'))) {
      const replacements = await ocrPdfPages(
        pdf,
        dir,
        sparse.map((page) => page.pageNumber),
      ).catch(() => new Map<number, { text: string; confidence: number }>());
      for (const page of sparse) {
        const replacement = replacements.get(page.pageNumber);
        if (replacement && replacement.text.trim().length > page.text.trim().length) {
          page.method = 'tesseract';
          page.text = replacement.text;
          page.confidence = replacement.confidence;
        }
      }
    }

    const usesOcr = pages.some((page) => page.method === 'tesseract');
    return {
      kind: 'pdf',
      method: usesOcr ? 'pdftotext+tesseract' : 'pdftotext',
      contentType,
      text: pages.map((page) => page.text).join('\f'),
      confidence: averageConfidence(pages),
      pages,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ocrPdfPages(
  pdf: string,
  dir: string,
  pageNumbers: number[],
): Promise<Map<number, { text: string; confidence: number }>> {
  const prefix = path.join(dir, 'page');
  for (const [first, last] of contiguousRanges(pageNumbers)) {
    await runCommand('pdftoppm', ['-f', String(first), '-l', String(last), '-png', '-r', '200', pdf, prefix]);
  }

  const filesByPage = new Map<number, string>();
  for (const file of await readdir(dir)) {
    const match = /^page-0*(\d+)\.png$/u.exec(file);
    if (match) filesByPage.set(Number(match[1]), path.join(dir, file));
  }

  // Each Actions runner is its own machine, so OCR every core's worth of pages at once -- tesseract is
  // single-threaded per page and this is the whole cost of a scanned filing.
  const out = new Map<number, { text: string; confidence: number }>();
  const queue = pageNumbers.filter((pageNumber) => filesByPage.has(pageNumber));
  const lanes = Math.max(1, Math.min(availableParallelism(), queue.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        out.set(next, await runTesseract(filesByPage.get(next)!));
      }
    }),
  );
  return out;
}

async function extractImage(buffer: Buffer, ext: string, contentType: string | null): Promise<ExtractedDocument> {
  const dir = await mkdtemp(path.join(tmpdir(), 'report-image-'));
  try {
    const file = path.join(dir, `source${ext || '.png'}`);
    await writeFile(file, buffer);
    const result = await runTesseract(file);
    return {
      kind: 'image',
      method: 'tesseract',
      contentType,
      text: result.text,
      confidence: result.confidence,
      pages: [{ pageNumber: 1, method: 'tesseract', text: result.text, confidence: result.confidence }],
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function extractSpreadsheet(buffer: Buffer, contentType: string | null): Promise<ExtractedDocument> {
  const XLSX = await import('@e965/xlsx');
  const book = XLSX.read(buffer, { type: 'buffer' });
  const sheets = book.SheetNames.map((name) => ({ name, csv: XLSX.utils.sheet_to_csv(book.Sheets[name]!) }));
  const text = sheets.map((sheet) => `# ${sheet.name}\n${sheet.csv}`).join('\n\n');
  return {
    kind: 'spreadsheet',
    method: 'xlsx',
    contentType,
    text,
    confidence: text.trim().length > 0 ? 0.9 : 0.2,
    pages: sheets.map((sheet, index) => ({ pageNumber: index + 1, method: 'xlsx', text: sheet.csv, confidence: 0.9 })),
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<\/(tr|p|div|li|h[1-6])>/giu, '\n')
    .replace(/<\/(td|th)>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/\s+\n/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ');
}

function looksLikeHtml(buffer: Buffer): boolean {
  return /<(html|table|body|div)\b/iu.test(buffer.subarray(0, 512).toString('utf8'));
}

function extensionForKind(kind: DocumentKind, url?: string): string {
  if (url) {
    const ext = path.extname(new URL(url, 'https://local.invalid').pathname);
    if (ext) return ext;
  }
  return kind === 'image' ? '.png' : '';
}

function averageConfidence(pages: Array<{ confidence: number }>): number {
  if (pages.length === 0) return 0;
  return Number((pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length).toFixed(4));
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new DocumentExtractionError('document_too_large', `document exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function runTesseract(file: string): Promise<{ text: string; confidence: number }> {
  const result = await runCommand('tesseract', [file, 'stdout', '-l', 'eng', '--psm', '6', 'tsv']);
  return parseTesseractTsv(result.stdout);
}

/**
 * Fails fast if any extraction tool is missing. Without tesseract, scanned pages would silently
 * yield no text -- a degraded result that still looks like a success -- so a runner that can't
 * OCR must not take work at all.
 */
export async function assertToolchain(): Promise<void> {
  const missing: string[] = [];
  // Poppler's tools reject `--version` (exit 1) and only accept `-v`; tesseract takes `--version`.
  for (const [tool, flag] of [['pdftotext', '-v'], ['pdftoppm', '-v'], ['tesseract', '--version']] as const) {
    if (!(await commandAvailable(tool, flag))) missing.push(tool);
  }
  if (missing.length > 0) throw new Error(`extraction toolchain incomplete: ${missing.join(', ')} not available`);
}

async function commandAvailable(command: string, versionFlag = '--version'): Promise<boolean> {
  return runCommand(command, [versionFlag]).then(
    () => true,
    () => false,
  );
}

function contiguousRanges(values: number[]): Array<[number, number]> {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const value of sorted) {
    const current = ranges.at(-1);
    if (current && value === current[1] + 1) current[1] = value;
    else ranges.push([value, value]);
  }
  return ranges;
}

export function parseTesseractTsv(tsv: string): { text: string; confidence: number } {
  const lines = new Map<string, string[]>();
  const confidences: number[] = [];
  for (const row of tsv.split(/\r?\n/u).slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12) continue;
    const word = columns.slice(11).join('\t').trim();
    if (!word) continue;
    const confidence = Number(columns[10]);
    if (Number.isFinite(confidence) && confidence >= 0) confidences.push(confidence);
    const key = columns.slice(1, 5).join(':');
    const words = lines.get(key) ?? [];
    words.push(word);
    lines.set(key, words);
  }
  const text = [...lines.values()].map((words) => words.join(' ')).join('\n');
  const confidence =
    confidences.length > 0
      ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length / 100).toFixed(4))
      : 0.2;
  return { text, confidence };
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new DocumentExtractionError('extract_failed', `${command} timed out`)));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new DocumentExtractionError(
            'extract_failed',
            error.code === 'ENOENT' ? `${command} is not installed` : `${command} failed to start`,
          ),
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) finish(() => resolve({ stdout: Buffer.concat(stdout).toString('utf8') }));
      else {
        const detail = Buffer.concat(stderr).toString('utf8').slice(0, 200);
        finish(() => reject(new DocumentExtractionError('extract_failed', `${command} exited ${code}: ${detail}`)));
      }
    });
  });
}
