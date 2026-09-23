import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DocumentCorpus } from './corpus.js';
import type { PeriodFigures } from './financials/derive.js';
import { extractFinancials } from './financials/filing.js';
import { financialsPayload } from './financials/payload.js';
import { psxPriceLookup } from './financials/price.js';
import { LlmClient } from './llm/client.js';
import { STATEMENT_OCR } from './process.js';

/**
 * Dry run of the financials pipeline over a fixed list of filings. For each, writes the exact
 * JSON the ingest webhook would receive (`<symbol>-<id>.json`), a trace of what the model read
 * and what the rulebook rejected, and a score against a hand-typed answer key where one exists.
 *
 * It never contacts the ingest API: this module does not import the API client, and the workflow
 * that runs it holds no identity token the API would accept. Nothing here reaches the database.
 *
 *   node dist/evaluate.js samples/hpl.json samples/hpl-answers.json out/ [id,id,...]
 */
interface Sample {
  url: string;
  symbol: string;
  reportType: string;
  periodEnded: string;
}

type AnswerKey = Record<string, Record<string, Record<string, number>>>;

interface Score {
  expected: number;
  correct: number;
  wrong: string[];
  missing: string[];
}

const SECTION = { income: 'income', balance: 'balance', cash_flow: 'cashFlow' } as const;

async function main(): Promise<void> {
  const [samplesPath = 'samples/hpl.json', answersPath = 'samples/hpl-answers.json', outDir = 'out', only] = process.argv.slice(2);
  const wanted = only ? new Set(only.split(',')) : null;
  // EVAL_SHARD="2/4": this job takes every 4th filing starting at the 2nd (parallel jobs).
  const [shard, shards] = (process.env.EVAL_SHARD ?? '1/1').split('/').map(Number) as [number, number];
  const samples = (JSON.parse(await readFile(samplesPath, 'utf8')) as Sample[])
    .filter((sample) => !wanted || wanted.has(new URL(sample.url).searchParams.get('id') ?? ''))
    .filter((_, index) => index % shards === shard - 1);
  const answers = JSON.parse(await readFile(answersPath, 'utf8').catch(() => '{}')) as AnswerKey;
  await mkdir(outDir, { recursive: true });

  const llm = LlmClient.fromEnv();
  if (!llm) throw new Error('LLM_URL is not set');
  await llm.waitUntilReady();
  const corpus = await DocumentCorpus.open({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.CORPUS_TOKEN,
    read: process.env.CORPUS_READ !== '0',
    outDir: process.env.CORPUS_OUT_DIR,
    log: (message) => console.log(message),
  });

  const rows: string[] = [];
  const details: string[] = [];
  const totals = { expected: 0, correct: 0 };
  for (const sample of samples) {
    const started = Date.now();
    const id = new URL(sample.url).searchParams.get('id') ?? String(rows.length + 1);
    try {
      const document = await corpus.obtain(sample.url, { symbol: sample.symbol }, STATEMENT_OCR);
      const prices = await psxPriceLookup(sample.symbol);
      const financials = await extractFinancials(llm, document, { periodEnded: sample.periodEnded }, prices);
      const payload = financialsPayload({ ...sample, sourceUrl: sample.url }, document, financials);
      const score = answers[sample.url] ? scorePeriods(financials.periods, answers[sample.url]!) : null;
      if (score) {
        totals.expected += score.expected;
        totals.correct += score.correct;
      }
      const counts = countFigures(financials.periods);
      const seconds = Math.round((Date.now() - started) / 1000);
      const modelSeconds = Math.round(financials.readings.reduce((sum, reading) => sum + reading.ms, 0) / 1000);
      const rejected = financials.readings.reduce((sum, reading) => sum + reading.dropped.length, 0);
      const ocrPages = document.pages.filter((page) => page.method === 'tesseract').length;

      await writeFile(path.join(outDir, `${sample.symbol}-${id}.json`), JSON.stringify(payload, null, 1));
      await writeFile(path.join(outDir, `${sample.symbol}-${id}.trace.json`), JSON.stringify({ sample, readings: financials.readings, score }, null, 1));
      rows.push(
        `| ${sample.reportType} ${sample.periodEnded} | [${id}](${sample.url}) | ${financials.periods.map((period) => `${period.periodEnd}${period.months ? `/${period.months}M` : ''}${period.basis === 'unknown' ? '' : ` ${period.basis.slice(0, 5)}`}`).join(', ')} | ${counts.reported} | ${counts.derived} | ${counts.empty} | ${rejected} | ${ocrPages} | ${score ? `${score.correct}/${score.expected}` : '-'} | ${modelSeconds}s / ${seconds}s |`,
      );
      details.push(detail(sample, id, financials.periods, score, financials.readings));
      console.log(`${sample.symbol} ${id} ${sample.periodEnded}: periods=${financials.periods.length} reported=${counts.reported} derived=${counts.derived} null=${counts.empty} rejected=${rejected}${score ? ` score=${score.correct}/${score.expected}` : ''} ${seconds}s`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 160) : 'failed';
      rows.push(`| ${sample.reportType} ${sample.periodEnded} | [${id}](${sample.url}) | FAILED: ${message} | | | | | | | |`);
      console.log(`${sample.symbol} ${id}: FAILED ${message}`);
    }
  }

  const accuracy = totals.expected > 0 ? ` Answer key: **${totals.correct}/${totals.expected}** hand-checked figures correct.` : '';
  const summary = [
    '## Financials extraction (dry run, nothing sent to the ingest API)',
    '',
    `Per filing: periods found, and across them how many figures were reported (read and verified), derived (calculated) or null.${accuracy}`,
    '',
    '| Filing | Document | Periods | Reported | Derived | Null | Rejected by rules | OCR pages | Answer key | Model / total time |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  await writeFile(path.join(outDir, 'summary.md'), `${summary}\n${details.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`corpus: hits=${corpus.stats.hits} misses=${corpus.stats.misses} saved=${corpus.stats.saved}`);
}

function scorePeriods(periods: PeriodFigures[], key: Record<string, Record<string, number>>): Score {
  const score: Score = { expected: 0, correct: 0, wrong: [], missing: [] };
  for (const [label, items] of Object.entries(key)) {
    const [statement, end, monthsText] = label.split('|') as [keyof typeof SECTION, string, string];
    const months = Number(monthsText);
    for (const [item, expected] of Object.entries(items)) {
      score.expected += 1;
      const found = periods
        .filter((period) => period.periodEnd === end && (months === 0 ? true : period.months === months))
        .map((period) => period[SECTION[statement]][item])
        .find((figure) => figure);
      if (!found) score.missing.push(`${label} ${item} (expected ${format(expected)})`);
      else if (Math.abs(found.value - expected) <= Math.max(Math.abs(expected) * 1e-9, 0.005)) score.correct += 1;
      else score.wrong.push(`${label} ${item}: expected ${format(expected)}, got ${format(found.value)} (${found.source})`);
    }
  }
  return score;
}

function countFigures(periods: PeriodFigures[]): { reported: number; derived: number; empty: number } {
  const counts = { reported: 0, derived: 0, empty: 0 };
  for (const period of periods) {
    for (const section of [period.income, period.balance, period.cashFlow, period.ratios]) {
      for (const figure of Object.values(section)) {
        if (!figure) counts.empty += 1;
        else if (figure.source === 'reported') counts.reported += 1;
        else counts.derived += 1;
      }
    }
  }
  return counts;
}

function detail(
  sample: Sample,
  id: string,
  periods: PeriodFigures[],
  score: Score | null,
  readings: Array<{ statementType: string; basis: string; pages: number[]; dropped: Array<{ item: string; reason: string }>; columns: Array<{ periodEnd: string; months: number; kept: boolean; reason?: string }>; error?: string }>,
): string {
  const lines = [`### ${sample.symbol} ${sample.reportType} ${sample.periodEnded} (${id})`, ''];
  if (score) {
    lines.push(`Answer key: ${score.correct}/${score.expected} correct.`);
    lines.push(...score.wrong.map((item) => `- WRONG ${item}`), ...score.missing.map((item) => `- missing ${item}`), '');
  }
  for (const reading of readings) {
    const cols = reading.columns.map((column) => `${column.periodEnd}${column.months ? `/${column.months}M` : ''}${column.kept ? '' : ` (dropped: ${column.reason})`}`).join(', ');
    lines.push(`- ${reading.statementType} ${reading.basis} p.${reading.pages.join('+')}: columns ${cols || 'none'}${reading.error ? ` ERROR ${reading.error}` : ''}`);
    for (const drop of reading.dropped) lines.push(`  - rejected ${drop.item}: ${drop.reason}`);
  }
  for (const period of periods) {
    lines.push('', `#### ${period.periodEnd} ${period.periodType} (${period.basis})${period.price ? ` price ${period.price.close} on ${period.price.date}` : ''}`, '', '| Section | Item | Value | Source |', '|---|---|---|---|');
    for (const [name, section] of [['income', period.income], ['balance', period.balance], ['cash flow', period.cashFlow], ['ratios', period.ratios]] as const) {
      for (const [item, figure] of Object.entries(section)) {
        if (!figure) continue;
        const source = figure.source === 'reported' ? `reported p.${figure.page}: ${(figure.text ?? '').replace(/\|/gu, '/').slice(0, 70)}` : `derived: ${figure.formula}`;
        lines.push(`| ${name} | ${item} | ${format(figure.value)} | ${source} |`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function format(value: number): string {
  return Math.abs(value) < 1_000 ? String(value) : value.toLocaleString('en-US');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'evaluation failed');
  process.exit(1);
});
