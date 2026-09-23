import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { runCommand } from '../extraction.js';
import type { PageSubset } from './subset.js';

/**
 * Stage 4 -- table extraction. Runs the Docling sidecar (`python -m docstage tables`) over the page
 * subset and maps its output back to the filing's page numbers.
 *
 * The sidecar is located through the environment, so the same code runs on a runner and locally:
 *   DOCSTAGE_PYTHON  python executable with docling installed (default: python3)
 *   DOCSTAGE_PATH    directory containing the `docstage` package (default: ./python)
 *   DOCLING_MODELS   directory of verified Docling models (required)
 *   TESSERACT        tesseract executable for scanned pages (default: tesseract)
 */
export interface TableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  columnHeader: boolean;
  rowHeader: boolean;
  rowSection: boolean;
}

export interface PageTable {
  /** [left, top, right, bottom] in points, top-left origin. */
  bbox: [number, number, number, number];
  rows: number;
  cols: number;
  cells: TableCell[];
}

export interface PageText {
  label: string;
  text: string;
  bbox: [number, number, number, number];
}

export interface PageTables {
  pageNumber: number;
  method: 'docling-pdf' | 'docling-ocr';
  width: number;
  height: number;
  texts: PageText[];
  tables: PageTable[];
}

export interface TableExtraction {
  pages: PageTables[];
  seconds: Record<string, number>;
}

interface SidecarPage {
  width: number;
  height: number;
  texts: PageText[];
  tables: PageTable[];
}

interface SidecarOutput {
  schemaVersion: number;
  native: Array<SidecarPage & { index: number }>;
  images: Array<SidecarPage & { file: string }>;
  seconds: Record<string, number>;
}

const SIDECAR_TIMEOUT_MS = 30 * 60_000;

export async function extractTables(subset: PageSubset, dir: string): Promise<TableExtraction> {
  if (!subset.nativePdf && subset.images.length === 0) return { pages: [], seconds: {} };
  const models = process.env.DOCLING_MODELS;
  if (!models) throw new Error('DOCLING_MODELS is not set');
  const out = path.join(dir, 'docstage.json');
  const args = ['-m', 'docstage', 'tables', '--models', models, '--threads', String(availableParallelism()), '--out', out];
  if (subset.nativePdf) args.push('--native', subset.nativePdf);
  for (const image of subset.images) args.push('--image', image.file);
  args.push('--tesseract', process.env.TESSERACT ?? 'tesseract');
  await runCommand(process.env.DOCSTAGE_PYTHON ?? 'python3', args, SIDECAR_TIMEOUT_MS, {
    PYTHONPATH: process.env.DOCSTAGE_PATH ?? path.resolve('python'),
    HF_HUB_OFFLINE: '1',
  });
  return fromSidecar(JSON.parse(await readFile(out, 'utf8')) as SidecarOutput, subset);
}

/** Maps the sidecar's pages (native.pdf page index, image file) back to the filing's page numbers. */
export function fromSidecar(output: SidecarOutput, subset: PageSubset): TableExtraction {
  if (output.schemaVersion !== 1) throw new Error(`docstage schema ${output.schemaVersion} is not supported`);
  const pages: PageTables[] = [];
  for (const page of output.native) {
    const pageNumber = subset.nativePages[page.index - 1];
    if (pageNumber === undefined) continue;
    pages.push({ pageNumber, method: 'docling-pdf', width: page.width, height: page.height, texts: page.texts, tables: page.tables });
  }
  for (const page of output.images) {
    const image = subset.images.find((item) => path.basename(item.file) === page.file);
    if (!image) continue;
    pages.push({ pageNumber: image.pageNumber, method: 'docling-ocr', width: page.width, height: page.height, texts: page.texts, tables: page.tables });
  }
  pages.sort((a, b) => a.pageNumber - b.pageNumber);
  return { pages, seconds: output.seconds };
}
