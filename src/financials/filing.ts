import type { ExtractedDocument } from '../extraction.js';
import type { LlmClient } from '../llm/client.js';
import { cropped, findStatementPages } from '../statements/pages.js';
import { buildRows } from '../statements/rows.js';
import { buildPeriods, type PeriodFigures, type PriceLookup, type ReportedValue } from './derive.js';
import { inferColumns, readStatementRows, type StatementReading } from './read.js';

/**
 * One filing, end to end: find its statements, read each (model labels rows, code takes and
 * checks the figures), then calculate everything derivable per period. The result is the
 * complete financial picture the filing supports: every defined item, reported, derived or null.
 */
export interface FilingFinancials {
  periods: PeriodFigures[];
  readings: StatementReading[];
  /** Pages the reported figures came from: the only page text sent as evidence. */
  evidencePages: number[];
}

export async function extractFinancials(
  llm: LlmClient,
  document: ExtractedDocument,
  filing: { periodEnded: string },
  price: PriceLookup = () => null,
): Promise<FilingFinancials> {
  const statements = findStatementPages(document);
  const yearEndMonthDay = financialYearEnd(statements);
  const readings: StatementReading[] = [];
  for (const statement of statements) {
    readings.push(await readStatementRows(llm, statement, { ...filing, yearEndMonthDay }));
  }
  const reported = dedupe(readings.flatMap((reading) => reading.values));
  reported.push(...parValue(document, reported));
  const evidencePages = [...new Set(reported.map((value) => value.page).filter((page): page is number => page !== null))].sort((a, b) => a - b);
  return { periods: buildPeriods(reported, price), readings, evidencePages };
}

/**
 * The company's financial year-end month-day, from the balance sheet's printed column headers: an
 * interim balance sheet compares with the last year-end (its second column); an annual one's own
 * date is the year-end.
 */
function financialYearEnd(statements: ReturnType<typeof findStatementPages>): string | null {
  const balance = statements.find((statement) => statement.statementType === 'balance_sheet');
  if (!balance) return null;
  const pages = cropped(balance);
  const columns = inferColumns(pages, buildRows(pages).rows, 'balance');
  if (!columns || columns.length === 0) return null;
  const [first, second] = columns;
  if (second?.monthDay && first?.monthDay && second.monthDay !== first.monthDay) return second.monthDay;
  return first?.monthDay ?? null;
}

/**
 * Face value of one ordinary share, from the share capital note ("Ordinary shares of Rs. 10/- each"),
 * matched deterministically and recorded with its printed line. It lets the share count be derived
 * from share capital when the count itself is not read. Applied to each balance-sheet date and
 * basis of the filing; a filing states one face value for all of them.
 */
function parValue(document: ExtractedDocument, reported: ReportedValue[]): ReportedValue[] {
  const pattern = /ordinary\s+shares\s+of\s+(?:rs\.?|pkr|rupees)\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:\/-)?\s*each/iu;
  for (const page of document.pages) {
    const line = page.text.split('\n').find((text) => pattern.test(text));
    if (!line) continue;
    const par = Number(pattern.exec(line)![1]);
    if (!(par > 0)) return [];
    const dates = new Map<string, ReportedValue>();
    for (const value of reported) if (value.statement === 'balance') dates.set(`${value.periodEnd}|${value.basis}`, value);
    return [...dates.values()].map((value) => ({
      statement: 'balance' as const,
      key: 'par_value_per_share',
      periodEnd: value.periodEnd,
      months: 0,
      basis: value.basis,
      value: par,
      page: page.pageNumber,
      text: line.replace(/\s+/gu, ' ').trim().slice(0, 300),
    }));
  }
  return [];
}

/** The same figure read twice (a statement repeated in a filing) keeps its first reading. */
function dedupe(values: ReportedValue[]): ReportedValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.statement}|${value.key}|${value.periodEnd}|${value.months}|${value.basis}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
