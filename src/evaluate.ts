import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PeriodFigures } from './financials/derive.js';
import { financialsPayload } from './financials/payload.js';
import { downloadDocument } from './extraction.js';
import { extractFilingFinancials, type FilingResult } from './pipeline/filing.js';

/**
 * Dry run of the financials pipeline over a fixed list of filings. For each, writes the exact
 * JSON the ingest webhook would receive (`<symbol>-<id>.json`), every stage's output (in
 * `<symbol>-<id>/`), and a score against a hand-typed answer key where one exists.
 *
 * It never contacts the ingest API: this module does not import the API client, and the workflow
 * that runs it holds no identity token the API would accept. Nothing here reaches the database.
 *
 *   node dist/evaluate.js samples/hpl.json samples/hpl-answers.json out/ [id,id,...]
 *
 * PDF_CACHE_DIR, when set, keeps downloaded PDFs between runs.
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
    .filter((sample) => !wanted || wanted.has(idOf(sample)))
    .filter((_, index) => index % shards === shard - 1);
  const answers = JSON.parse(await readFile(answersPath, 'utf8').catch(() => '{}')) as AnswerKey;
  await mkdir(outDir, { recursive: true });

  const rows: string[] = [];
  const details: string[] = [];
  const totals = { expected: 0, correct: 0, wrong: 0 };
  for (const sample of samples) {
    const started = Date.now();
    const id = idOf(sample);
    const workDir = path.join(outDir, `${sample.symbol}-${id}`);
    try {
      const pdf = await obtainPdf(sample.url, id, workDir);
      // As in production: market-based items are left to the server (source "runtime").
      const result = await extractFilingFinancials(pdf, { periodEnded: sample.periodEnded }, () => null, workDir);
      const payload = financialsPayload({ ...sample, sourceUrl: sample.url }, result);
      const score = answers[sample.url] ? scorePeriods(result.periods, answers[sample.url]!) : null;
      if (score) {
        totals.expected += score.expected;
        totals.correct += score.correct;
        totals.wrong += score.wrong.length;
      }
      const counts = countFigures(result.periods);
      const seconds = Math.round((Date.now() - started) / 1000);
      await writeFile(path.join(outDir, `${sample.symbol}-${id}.json`), JSON.stringify(payload, null, 1));
      const kept = result.classification.selectedPages.length;
      const scanned = result.analysis.pages.filter((page) => page.kind === 'scanned').length;
      const unmatched = result.statements.reduce((sum, statement) => sum + statement.unmatched.length, 0);
      rows.push(
        `| ${sample.reportType} ${sample.periodEnded} | [${id}](${sample.url}) | ${kept}/${result.analysis.pageCount}${scanned ? ` (${scanned} scanned)` : ''} | ${result.periods.map(periodName).join(', ')} | ${counts.reported} | ${counts.derived} | ${counts.empty} | ${result.drops.length} | ${unmatched} | ${score ? `${score.correct}/${score.expected}${score.wrong.length ? ` (**${score.wrong.length} wrong**)` : ''}` : '-'} | ${seconds}s |`,
      );
      details.push(detail(sample, id, result, score));
      console.log(`${sample.symbol} ${id} ${sample.periodEnded}: pages=${kept}/${result.analysis.pageCount} periods=${result.periods.length} reported=${counts.reported} derived=${counts.derived} null=${counts.empty} dropped=${result.drops.length}${score ? ` score=${score.correct}/${score.expected} wrong=${score.wrong.length}` : ''} ${seconds}s ${JSON.stringify(result.timings)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 160) : 'failed';
      rows.push(`| ${sample.reportType} ${sample.periodEnded} | [${id}](${sample.url}) | FAILED: ${message} | | | | | | | | |`);
      console.log(`${sample.symbol} ${id}: FAILED ${message}`);
    }
  }

  const accuracy = totals.expected > 0 ? ` Answer key: **${totals.correct}/${totals.expected}** hand-checked figures correct, **${totals.wrong}** wrong.` : '';
  const summary = [
    '## Financials extraction (dry run, nothing sent to the ingest API)',
    '',
    `Per filing: pages kept by the classifier, periods found, and across them how many figures were reported (read and verified), derived (calculated) or null.${accuracy}`,
    '',
    '| Filing | Document | Pages read | Periods | Reported | Derived | Null | Dropped by checks | Unmatched rows | Answer key | Time |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  await writeFile(path.join(outDir, 'summary.md'), `${summary}\n${details.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

function idOf(sample: Sample): string {
  return new URL(sample.url).searchParams.get('id') ?? sample.url.replace(/\W+/gu, '-').slice(-40);
}

async function obtainPdf(url: string, id: string, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const cacheDir = process.env.PDF_CACHE_DIR;
  const cached = cacheDir ? path.join(cacheDir, `${id}.pdf`) : null;
  if (cached) {
    const buffer = await readFile(cached).catch(() => null);
    if (buffer && buffer.subarray(0, 4).toString('ascii') === '%PDF') return cached;
  }
  const { buffer } = await downloadDocument(url);
  if (buffer.subarray(0, 4).toString('ascii') !== '%PDF') throw new Error('document is not a PDF');
  const file = cached ?? path.join(workDir, 'source.pdf');
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  await writeFile(file, buffer);
  return file;
}

function periodName(period: PeriodFigures): string {
  return `${period.periodEnd}${period.months ? `/${period.months}M` : ''}${period.basis === 'unknown' ? '' : ` ${period.basis.slice(0, 5)}`}`;
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
      else score.wrong.push(`${label} ${item}: expected ${format(expected)}, got ${format(found.value)} (${found.source}${found.formula ? `: ${found.formula}` : ''})`);
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

function detail(sample: Sample, id: string, result: FilingResult, score: Score | null): string {
  const lines = [`### ${sample.symbol} ${sample.reportType} ${sample.periodEnded} (${id})`, ''];
  lines.push(`Stages (ms): ${Object.entries(result.timings).map(([name, ms]) => `${name} ${ms}`).join(', ')}.`, '');
  if (score) {
    lines.push(`Answer key: ${score.correct}/${score.expected} correct.`);
    lines.push(...score.wrong.map((item) => `- WRONG ${item}`), ...score.missing.map((item) => `- missing ${item}`), '');
  }
  lines.push('Pages kept:', ...result.classification.pages.filter((page) => page.selected).map((page) => `- p.${page.pageNumber} ${page.class}${page.topic ? ` (${page.topic})` : ''} ${page.basis}: ${page.reasons.join('; ').slice(0, 160)}`), '');
  for (const statement of result.statements) {
    const cols = statement.columns.map((column) => `${column.periodEnd ?? '?'}${column.months ? `/${column.months}M` : ''}${column.kept ? '' : ` (dropped: ${column.reason})`}`).join(', ');
    lines.push(`- ${statement.statementType} ${statement.basis} p.${statement.pages.join('+')} (${statement.method}, x${statement.unitScale}): ${statement.rows} rows, ${statement.matched} matched, ${statement.confirmedRows} confirmed by arithmetic; columns ${cols || 'none'}`);
    if (statement.unmatched.length) lines.push(`  - unmatched: ${statement.unmatched.join('; ')}`);
    for (const problem of statement.problems) lines.push(`  - problem: ${problem}`);
  }
  for (const drop of result.drops) lines.push(`- dropped ${drop.item}: ${drop.reason}`);
  for (const period of result.periods) {
    lines.push('', `#### ${period.periodEnd} ${period.periodType} (${period.basis})${period.price ? ` price ${period.price.close} on ${period.price.date}` : ''}`, '', '| Section | Item | Value | Source |', '|---|---|---|---|');
    for (const [name, section] of [['income', period.income], ['balance', period.balance], ['cash flow', period.cashFlow], ['ratios', period.ratios]] as const) {
      for (const [item, figure] of Object.entries(section)) {
        if (!figure) continue;
        const source = figure.source === 'reported' ? `reported p.${figure.page}${figure.checks?.length ? ` [${figure.checks.join(', ')}]` : ''}: ${(figure.text ?? '').replace(/\|/gu, '/').slice(0, 70)}` : `derived: ${figure.formula}`;
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
