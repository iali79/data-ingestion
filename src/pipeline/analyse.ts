import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../extraction.js';

/**
 * Stage 1 -- fast analysis. Looks at every page cheaply so later stages only spend real work on
 * the few pages that matter:
 * - the text layer (`pdftotext -layout`, milliseconds for a whole filing);
 * - how much of the page is covered by raster images (`pdfimages -list`), to tell a scanned
 *   page from a native one;
 * - for scanned pages only, the top strip OCRed at low resolution -- enough to read the page's
 *   title for the classifier, a fraction of the cost of OCRing the whole page.
 *
 * Native vs scanned is decided per page, not per document: a filing can be typed text with a
 * scanned auditor's report, or scanned statements behind a typed cover.
 */
export type PageKind = 'native' | 'scanned' | 'blank';

export interface PageAnalysis {
  pageNumber: number;
  kind: PageKind;
  /**
   * Layout text for a native page. For a scanned one: the OCRed title strip (or whole page, see
   * `ocrWholePages`), followed by the overlay text layer.
   */
  text: string;
  /** A scanned page's own text layer (page number, running title, a caption or two), if any. */
  overlay: string;
  /** Where `text` came from. */
  textSource: 'pdftotext' | 'ocr-strip' | 'ocr-page' | 'none';
  chars: number;
  /** Share of the page area covered by raster images, 0..1. */
  imageCoverage: number;
  width: number;
  height: number;
}

export interface DocumentAnalysis {
  pageCount: number;
  pages: PageAnalysis[];
  ms: number;
}

/**
 * A page with less text layer than this, on top of raster images, is a scan: the characters are an
 * overlay (page number, running title, a few captions) printed over a scanned image of the page.
 * Real native statement pages carry well over a thousand characters.
 */
const SCANNED_MAX_CHARS = 400;
/** Share of the page covered by images from which a sparse-text page counts as scanned. */
const SCANNED_MIN_COVERAGE = 0.15;
/** Resolution and height of the title strip OCRed on scanned pages. */
const STRIP_DPI = 150;
const STRIP_SHARE = 0.35;
const PAGE_DPI = 150;

export async function analysePdf(pdf: string): Promise<DocumentAnalysis> {
  const started = Date.now();
  const [text, images, sizes] = await Promise.all([
    runCommand('pdftotext', ['-layout', pdf, '-']),
    runCommand('pdfimages', ['-list', pdf]).catch(() => ({ stdout: '' })),
    runCommand('pdfinfo', ['-f', '1', '-l', '100000', pdf]),
  ]);
  const pageSizes = parsePageSizes(sizes.stdout);
  const texts = text.stdout.split('\f');
  if (texts.length > pageSizes.size && texts.at(-1)?.trim() === '') texts.pop();
  const coverage = imageCoverage(images.stdout, pageSizes);

  const pages: PageAnalysis[] = texts.map((pageText, index) => {
    const pageNumber = index + 1;
    const size = pageSizes.get(pageNumber) ?? { width: 612, height: 792 };
    const chars = pageText.replace(/\s+/gu, '').length;
    const covered = coverage.get(pageNumber) ?? 0;
    const kind: PageKind = covered >= SCANNED_MIN_COVERAGE && chars < SCANNED_MAX_CHARS ? 'scanned' : chars > 0 ? 'native' : 'blank';
    const overlay = kind === 'scanned' ? pageText.trim() : '';
    return { pageNumber, kind, text: pageText, overlay, textSource: chars > 0 ? 'pdftotext' : 'none', chars, imageCoverage: round(covered), ...size };
  });

  const scanned = pages.filter((page) => page.kind === 'scanned');
  if (scanned.length > 0) await ocrPages(pdf, scanned, 'strip');
  return { pageCount: pages.length, pages, ms: Date.now() - started };
}

/**
 * OCR scanned pages in full (low resolution) when their title strips were not enough to find
 * the statements -- a title printed below the top third, or a strip too noisy to read.
 */
export async function ocrWholePages(pdf: string, pages: PageAnalysis[]): Promise<void> {
  await ocrPages(
    pdf,
    pages.filter((page) => page.kind === 'scanned' && page.textSource !== 'ocr-page'),
    'page',
  );
}

async function ocrPages(pdf: string, pages: PageAnalysis[], mode: 'strip' | 'page'): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'analyse-'));
  try {
    const queue = [...pages];
    const lanes = Math.max(1, Math.min(availableParallelism(), queue.length));
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (let page = queue.shift(); page; page = queue.shift()) {
          const dpi = mode === 'strip' ? STRIP_DPI : PAGE_DPI;
          const prefix = path.join(dir, `p${page.pageNumber}-${mode}`);
          const crop = mode === 'strip' ? ['-x', '0', '-y', '0', '-W', String(Math.ceil((page.width / 72) * dpi)), '-H', String(Math.ceil((page.height / 72) * dpi * STRIP_SHARE))] : [];
          await runCommand('pdftoppm', ['-f', String(page.pageNumber), '-l', String(page.pageNumber), '-r', String(dpi), '-gray', '-singlefile', ...crop, '-png', pdf, prefix]);
          const image = `${prefix}.png`;
          const result = await runTesseractLayout(image);
          // Keep the overlay text too: it can carry a caption or title the OCR misreads.
          page.text = page.overlay ? `${result}\n${page.overlay}` : result;
          page.textSource = mode === 'strip' ? 'ocr-strip' : 'ocr-page';
          await rm(image, { force: true });
        }
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Tesseract keeping line layout (`--psm 4`, one column of variable-size text), so a heading keeps
 * its words together and a statement row keeps its caption and figures on one line. One thread
 * per process: pages already run one per core, and tesseract's own OpenMP threads on top of that
 * oversubscribe the CPU until single pages take minutes.
 */
async function runTesseractLayout(image: string): Promise<string> {
  const { stdout } = await runCommand('tesseract', [image, 'stdout', '-l', 'eng', '--psm', '4'], 90_000, { OMP_THREAD_LIMIT: '1' });
  return stdout;
}

function parsePageSizes(info: string): Map<number, { width: number; height: number }> {
  const sizes = new Map<number, { width: number; height: number }>();
  for (const match of info.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gmu)) {
    sizes.set(Number(match[1]), { width: Number(match[2]), height: Number(match[3]) });
  }
  return sizes;
}

/** Sum of image areas per page (in points, from pixel size and ppi) over the page area, capped at 1. */
function imageCoverage(list: string, sizes: Map<number, { width: number; height: number }>): Map<number, number> {
  const covered = new Map<number, number>();
  for (const line of list.split('\n').slice(2)) {
    const cells = line.trim().split(/\s+/u);
    if (cells.length < 14 || cells[2] !== 'image') continue;
    const [page, width, height, xppi, yppi] = [cells[0], cells[3], cells[4], cells[12], cells[13]].map(Number) as [number, number, number, number, number];
    const size = sizes.get(page);
    if (!size || !(xppi > 0) || !(yppi > 0)) continue;
    const area = ((width / xppi) * 72 * (height / yppi) * 72) / (size.width * size.height);
    covered.set(page, Math.min(1, (covered.get(page) ?? 0) + area));
  }
  return covered;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

