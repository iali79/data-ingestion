import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeDocument, toLinePayload, type StatementLinePayload } from './contract.js';
import { DocumentCorpus } from './corpus.js';
import { LlmClient } from './llm/client.js';
import { STATEMENT_OCR } from './process.js';
import { extractStatements } from './statements/extract.js';

/**
 * Dry run of the statement pipeline over a fixed list of filings. Writes, per filing, exactly the
 * lines the ingest API would receive, plus a trace of what the model read and what verification
 * dropped -- and scores them against a hand-typed answer key where one exists.
 *
 * It never contacts the ingest API: this module does not import the API client, and the workflow
 * that runs it holds no identity token the API would accept. Nothing here reaches the database.
 *
 *   node dist/evaluate.js samples/hpl.json samples/hpl-answers.json out/
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
  wrong: Array<{ period: string; item: string; expected: number; got: number }>;
  missing: Array<{ period: string; item: string; expected: number }>;
}

async function main(): Promise<void> {
  const [samplesPath = 'samples/hpl.json', answersPath = 'samples/hpl-answers.json', outDir = 'out'] = process.argv.slice(2);
  const samples = JSON.parse(await readFile(samplesPath, 'utf8')) as Sample[];
  const answers = (JSON.parse(await readFile(answersPath, 'utf8').catch(() => '{}')) as AnswerKey) ?? {};
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
      const hitsBefore = corpus.stats.hits;
      const document = await corpus.obtain(sample.url, { symbol: sample.symbol }, STATEMENT_OCR);
      const extraction = await extractStatements(llm, document, { periodEnded: sample.periodEnded });
      const lines = extraction.lines.map(toLinePayload);
      const ocrPages = document.pages.filter((page) => page.method === 'tesseract').length;
      const seconds = Math.round((Date.now() - started) / 1000);
      const modelSeconds = Math.round(extraction.statements.reduce((sum, item) => sum + item.ms, 0) / 1000);
      const dropped = extraction.statements.reduce((sum, item) => sum + item.dropped.length, 0);
      const score = answers[sample.url] ? scoreLines(lines, answers[sample.url]!) : null;
      if (score) {
        totals.expected += score.expected;
        totals.correct += score.correct;
      }

      await writeFile(
        path.join(outDir, `${sample.symbol}-${id}.json`),
        JSON.stringify(
          {
            sample,
            document: { ...summarizeDocument(document), ocr: document.ocr, ocrPages, fromCorpus: corpus.stats.hits > hitsBefore },
            statements: extraction.statements,
            evidencePages: extraction.evidencePages,
            lines,
            score,
          },
          null,
          1,
        ),
      );
      rows.push(
        `| ${sample.reportType} ${sample.periodEnded} | [${id}](${sample.url}) | ${statementsFound(extraction.statements)} | ${lines.length} | ${dropped} | ${ocrPages} | ${extraction.evidencePages.join(', ')} | ${score ? `${score.correct}/${score.expected}` : '-'} | ${modelSeconds}s / ${seconds}s |`,
      );
      details.push(detailSection(sample, id, lines, score, extraction.statements));
      console.log(`${sample.symbol} ${id} ${sample.periodEnded}: lines=${lines.length} dropped=${dropped} ocr_pages=${ocrPages}${score ? ` score=${score.correct}/${score.expected}` : ''} ${seconds}s`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 160) : 'failed';
      rows.push(`| ${sample.reportType} ${sample.periodEnded} | [${id}](${sample.url}) | FAILED: ${message} | | | | | | |`);
      console.log(`${sample.symbol} ${id}: FAILED ${message}`);
    }
  }

  const accuracy = totals.expected > 0 ? ` Scored against the answer key: **${totals.correct}/${totals.expected}** correct.` : '';
  const summary = [
    '## Statement extraction (dry run, nothing sent to the ingest API)',
    '',
    `Model-read and verified figures per filing.${accuracy}`,
    '',
    '| Filing | Document | Statements found | Lines | Dropped by checks | OCR pages | Evidence pages | Answer key | Model / total time |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  await writeFile(path.join(outDir, 'summary.md'), `${summary}\n${details.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`corpus: hits=${corpus.stats.hits} misses=${corpus.stats.misses} saved=${corpus.stats.saved}`);
}

function scoreLines(lines: StatementLinePayload[], key: Record<string, Record<string, number>>): Score {
  const score: Score = { expected: 0, correct: 0, wrong: [], missing: [] };
  for (const [period, items] of Object.entries(key)) {
    for (const [item, expected] of Object.entries(items)) {
      score.expected += 1;
      const candidates = lines.filter((line) => line.periodLabel === period && line.canonicalLineItem === item);
      if (candidates.length === 0) score.missing.push({ period, item, expected });
      else if (candidates.some((line) => Math.abs(line.value - expected) <= Math.max(Math.abs(expected) * 1e-9, 0.005))) score.correct += 1;
      else score.wrong.push({ period, item, expected, got: candidates[0]!.value });
    }
  }
  return score;
}

function statementsFound(statements: Array<{ statementType: string; basis: string; found: boolean; error?: string }>): string {
  return statements
    .map((item) => `${item.statementType.replace('income_statement', 'P&L').replace('balance_sheet', 'BS').replace('cash_flow', 'CF')}${item.basis === 'unknown' ? '' : `/${item.basis.slice(0, 5)}`}${item.error ? ' (error)' : item.found ? '' : ' (not found)'}`)
    .join(', ');
}

function detailSection(
  sample: Sample,
  id: string,
  lines: StatementLinePayload[],
  score: Score | null,
  statements: Array<{ statementType: string; dropped: Array<{ item: string; reason: string }>; columns: Array<{ periodEnd: string; months: number; kept: boolean; reason?: string }> }>,
): string {
  const table = lines
    .filter((line) => !line.sourceText.startsWith('Derived from'))
    .map((line) => `| ${line.statementType} | ${line.consolidationBasis} | ${line.periodLabel} | ${line.canonicalLineItem} | ${formatValue(line.value)} | ${line.sourcePage ?? ''} | ${line.sourceText.replace(/\|/gu, '/').slice(0, 90)} |`)
    .join('\n');
  const drops = statements.flatMap((item) => item.dropped.map((drop) => `- ${item.statementType}: ${drop.item} - ${drop.reason}`));
  const columns = statements.flatMap((item) => item.columns.filter((column) => !column.kept).map((column) => `- ${item.statementType}: column ${column.periodEnd} dropped - ${column.reason}`));
  const scoring = score
    ? [
        `Answer key: ${score.correct}/${score.expected} correct.`,
        ...score.wrong.map((item) => `- WRONG ${item.period} ${item.item}: expected ${formatValue(item.expected)}, got ${formatValue(item.got)}`),
        ...score.missing.map((item) => `- missing ${item.period} ${item.item} (expected ${formatValue(item.expected)})`),
      ].join('\n')
    : '';
  return [
    `### ${sample.symbol} ${sample.reportType} ${sample.periodEnded} (${id})`,
    '',
    scoring,
    drops.length || columns.length ? `\nDropped by verification:\n${[...columns, ...drops].join('\n')}` : '',
    '',
    '| Statement | Basis | Period | Item | Value (PKR) | Page | Source line |',
    '|---|---|---|---|---|---|---|',
    table,
    '',
  ].join('\n');
}

function formatValue(value: number): string {
  return Math.abs(value) < 1_000 ? String(value) : value.toLocaleString('en-US');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'evaluation failed');
  process.exit(1);
});
