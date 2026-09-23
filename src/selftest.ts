import { appendFile } from 'node:fs/promises';
import { selectEvidencePages, statementStatus, toLinePayload } from './contract.js';
import { DocumentCorpus } from './corpus.js';
import { assertToolchain, type ExtractedDocument } from './extraction.js';
import { parseFinancialStatements } from './parser.js';

/**
 * Toolchain self-test: extracts a few public PSX filings exactly as a real task would, without
 * contacting the ingest API. Proves the runner image (poppler, tesseract, OCR parallelism) and the
 * parser work end to end. Prints counts only -- never document text.
 *
 * With CORPUS_OUT_DIR set it also saves the extracted text as corpus records, and
 * `--from-corpus` then reads the same filings back from the published corpus instead of
 * downloading them, proving the save -> publish -> read loop.
 */
const SAMPLES = [
  { label: 'text-layer annual report', url: 'https://financials.psx.com.pk/lib/DownloadPDF.php?id=272758', periodEnded: '2025', expectOcr: false },
  { label: 'scanned filing (OCR)', url: 'https://financials.psx.com.pk/lib/DownloadPDF.php?id=283180', periodEnded: '2026-06-30', expectOcr: true },
];

async function main(): Promise<void> {
  const fromCorpus = process.argv.includes('--from-corpus');
  const corpus = await DocumentCorpus.open({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.CORPUS_TOKEN,
    read: fromCorpus,
    outDir: fromCorpus ? null : process.env.CORPUS_OUT_DIR,
    log: (message) => console.log(message),
  });
  if (!fromCorpus) await assertToolchain();

  const rows: string[] = [];
  let failures = 0;
  for (const sample of SAMPLES) {
    const started = Date.now();
    try {
      let document: ExtractedDocument;
      if (fromCorpus) {
        const saved = await corpus.load(sample.url);
        if (!saved) throw new Error('not found in the published corpus');
        document = saved;
      } else {
        document = await corpus.obtain(sample.url, { symbol: 'SELFTEST' });
      }
      const periodEnd = /^\d{4}-\d{2}-\d{2}$/u.test(sample.periodEnded) ? new Date(`${sample.periodEnded}T00:00:00Z`) : null;
      const parsed = parseFinancialStatements(document.text, {
        periodLabel: sample.periodEnded,
        periodEnd,
        pageConfidences: document.pages.map((page) => page.confidence),
      });
      const lines = parsed.promoted.map(toLinePayload);
      const ocrPages = document.pages.filter((page) => page.method === 'tesseract').length;
      const row = `${sample.label}${fromCorpus ? ' [corpus]' : ''}: method=${document.method} pages=${document.pages.length} ocr_pages=${ocrPages} lines=${lines.length} status=${statementStatus(parsed.promoted, parsed.candidates.length, document.kind)} evidence_pages=${selectEvidencePages(document, lines).length} ${Math.round((Date.now() - started) / 1000)}s`;
      console.log(row);
      rows.push(`- ${row}`);
      if (lines.length === 0) failures += 1;
      if (sample.expectOcr && ocrPages === 0) {
        failures += 1;
        console.log(`${sample.label}: expected OCR pages but none were produced`);
      }
    } catch (error) {
      failures += 1;
      const row = `${sample.label}: FAILED ${(error as Error).message.slice(0, 120)}`;
      console.log(row);
      rows.push(`- ${row}`);
    }
  }
  const heading = fromCorpus ? 'Corpus read-back' : 'Toolchain self-test';
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ${heading}\n\n${rows.join('\n')}\n`);
  if (failures > 0) process.exit(1);
}

void main();
