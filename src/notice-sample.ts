import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DocumentCorpus } from './corpus.js';
import { assertToolchain } from './extraction.js';
import { PAYOUT_OCR } from './payout.js';

/**
 * Notice sample: reads a fixed list of public PSX notices exactly as a payout notice task would
 * (first pages only, OCR for scans) and keeps each one's page text, so the payout parser can be
 * measured and its fixtures taken from real OCR output. A dry run: it never contacts the ingest
 * API and holds no identity token.
 *
 *   node dist/notice-sample.js <samples.json> <outDir>
 *
 * `samples.json` is `[{ symbol, title, publishedAt, sourceUrl }]`. NOTICE_SHARD="2/4" takes every
 * 4th notice starting at the 2nd (parallel jobs). With CORPUS_OUT_DIR set the text is also saved
 * as corpus records, so a later real run reads it instead of OCR'ing the notice again.
 */
interface NoticeSample {
  symbol: string;
  title: string;
  publishedAt: string;
  sourceUrl: string;
}

const ALLOWED = /^https:\/\/dps\.psx\.com\.pk\/download\/(?:document|attachment)\/[\w-]+\.pdf$/u;

async function main(): Promise<void> {
  const [samplesPath, outDir] = process.argv.slice(2);
  if (!samplesPath || !outDir) throw new Error('usage: notice-sample <samples.json> <outDir>');
  const [shard, shards] = (process.env.NOTICE_SHARD ?? '1/1').split('/').map(Number) as [number, number];
  const samples = (JSON.parse(await readFile(samplesPath, 'utf8')) as NoticeSample[])
    .filter((sample) => ALLOWED.test(sample.sourceUrl))
    .filter((_, index) => index % shards === shard - 1);
  await mkdir(outDir, { recursive: true });
  await assertToolchain();
  const corpus = await DocumentCorpus.open({ read: false, outDir: process.env.CORPUS_OUT_DIR ?? null, log: (message) => console.log(message) });

  let read = 0;
  let failed = 0;
  for (const sample of samples) {
    const started = Date.now();
    try {
      const document = await corpus.obtain(sample.sourceUrl, { symbol: sample.symbol }, PAYOUT_OCR);
      const pages = document.pages.slice(0, PAYOUT_OCR.pages).map((page) => ({ pageNumber: page.pageNumber, method: page.method, confidence: page.confidence, text: page.text }));
      const id = /\/([\w-]+)\.pdf$/u.exec(sample.sourceUrl)?.[1] ?? 'notice';
      await writeFile(path.join(outDir, `${sample.symbol}-${id}.json`), JSON.stringify({ ...sample, method: document.method, pageCount: document.pages.length, pages }, null, 1));
      read += 1;
      console.log(`${sample.symbol} ${sample.publishedAt.slice(0, 10)} ${id}: ${document.method} ${document.pages.length}p ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (error) {
      failed += 1;
      console.log(`${sample.symbol} ${sample.sourceUrl}: FAILED ${(error as Error).message.slice(0, 120)}`);
    }
  }
  const summary = `Notice sample shard ${shard}/${shards}: ${read} read, ${failed} failed`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${summary}\n`);
}

void main();
