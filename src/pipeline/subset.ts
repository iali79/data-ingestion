import path from 'node:path';
import { runCommand } from '../extraction.js';
import type { DocumentAnalysis } from './analyse.js';

/**
 * Stage 3 -- cut the selected pages out of the filing, in the form Stage 4 needs:
 * - native pages into one small PDF (`native.pdf`), keeping their text layer;
 * - each scanned page as a 300 dpi greyscale image, so table extraction reads the pixels and not a
 *   partial text overlay.
 * The page map ties every piece back to its page number in the original filing.
 */
export interface PageSubset {
  nativePdf: string | null;
  /** Original page number of native.pdf's page 1, 2, ... */
  nativePages: number[];
  images: Array<{ file: string; pageNumber: number }>;
}

const SCAN_DPI = 300;

export async function subsetPages(pdf: string, analysis: DocumentAnalysis, pageNumbers: number[], dir: string): Promise<PageSubset> {
  const wanted = [...new Set(pageNumbers)].sort((a, b) => a - b);
  const kinds = new Map(analysis.pages.map((page) => [page.pageNumber, page.kind]));
  const nativePages = wanted.filter((pageNumber) => kinds.get(pageNumber) === 'native');
  const scannedPages = wanted.filter((pageNumber) => kinds.get(pageNumber) === 'scanned');

  let nativePdf: string | null = null;
  if (nativePages.length > 0) {
    nativePdf = path.join(dir, 'native.pdf');
    const singles: string[] = [];
    for (const pageNumber of nativePages) {
      const single = path.join(dir, `native-${pageNumber}.pdf`);
      await runCommand('pdfseparate', ['-f', String(pageNumber), '-l', String(pageNumber), pdf, single]);
      singles.push(single);
    }
    if (singles.length === 1) await runCommand('cp', [singles[0]!, nativePdf]);
    else await runCommand('pdfunite', [...singles, nativePdf]);
  }

  const images: PageSubset['images'] = [];
  for (const pageNumber of scannedPages) {
    const prefix = path.join(dir, `scan-${pageNumber}`);
    await runCommand('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(SCAN_DPI), '-gray', '-singlefile', '-png', pdf, prefix]);
    images.push({ file: `${prefix}.png`, pageNumber });
  }
  return { nativePdf, nativePages, images };
}
