import type { LlmClient } from '../llm/client.js';
import type { StatementType } from '../parser.js';
import { cropped, type StatementPage } from '../statements/pages.js';
import { buildRows, figureValue, type Row } from '../statements/rows.js';
import { CAPTIONS, readableItems, type ItemDefinition, type Statement } from './definitions.js';
import { modelRules } from './rulebook.js';
import type { ReportedValue } from './derive.js';

/**
 * Reads one statement: code splits its page into numbered rows, the model says what each value
 * column is (period end and length) and which row holds which item, and code takes the figures
 * from those rows. The model never writes a number, so it cannot invent or mistype one.
 *
 * Checks, all in code:
 *   - a column's period must be a real date whose year is printed in the heading, and near the
 *     filing's own period;
 *   - a row must print at least as many figures as there are value columns (extra leading
 *     figures are note references);
 *   - two rows mapped to one item with different figures -> the item is dropped, not guessed;
 *   - accounting identities per period (gross profit, profit after tax, total assets).
 */
export interface StatementReading {
  statementType: StatementType;
  basis: string;
  pages: number[];
  found: boolean;
  columns: Array<{ periodEnd: string; months: number; kept: boolean; reason?: string }>;
  unitScale: number;
  values: ReportedValue[];
  mapped: number;
  dropped: Array<{ item: string; reason: string }>;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  error?: string;
}

const STATEMENT_OF: Record<StatementType, Statement> = { income_statement: 'income', balance_sheet: 'balance', cash_flow: 'cash_flow' };
const TITLE: Record<StatementType, string> = {
  income_statement: 'statement of profit or loss (income statement)',
  balance_sheet: 'statement of financial position (balance sheet)',
  cash_flow: 'statement of cash flows',
};

/** Income-statement costs are delivered as positive magnitudes whatever sign the filing prints. */
const EXPENSES = new Set([
  'cost_of_sales', 'distribution_cost', 'admin_expenses', 'selling_admin_expenses', 'rd_expenses',
  'other_operating_expenses', 'operating_expenses', 'depreciation_amortization', 'finance_cost',
  'levies', 'taxation', 'preferred_dividends',
]);
/** Balance-sheet items that cannot be negative; a negative reading is a misread row. */
const NON_NEGATIVE = new Set([
  'revenue', 'cash_and_equivalents', 'short_term_investments', 'net_receivables', 'total_inventory',
  'total_current_assets', 'net_ppe', 'total_assets', 'total_current_liabilities', 'accounts_payable',
  'short_term_borrowings', 'share_capital', 'total_liabilities',
]);
const PER_SHARE = new Set(['eps_basic', 'eps_diluted']);
const PERIOD_WINDOW_DAYS = 540;

function systemPrompt(kind: Statement): string {
  return [
    'You label the rows of a Pakistani listed company\u2019s financial statement.',
    'The page is given as numbered rows: "R12: caption || figures". Figures in [brackets] are printed before the caption. "(no caption)" rows are unlabelled totals: use the headings above them to see what they total.',
    'Return found (false if the requested statement is not on the page), unit, columns (one per value column) and rows: an object from item name to row id, containing only items printed on the page.',
    'Follow these rules exactly:',
    modelRules(kind),
  ].join('\n');
}

function schema(items: ItemDefinition[]): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['found', 'unit', 'columns', 'rows'],
    properties: {
      found: { type: 'boolean' },
      unit: { type: 'string', enum: ['rupees', 'thousands', 'millions'] },
      columns: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['period_end', 'months'],
          properties: {
            period_end: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
            months: { type: 'integer', enum: [0, 3, 6, 9, 12] },
          },
        },
      },
      // item -> row id, only for items printed on the page (every property optional).
      rows: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(items.map((item) => [item.key, { type: 'string', pattern: '^R[0-9]{1,3}$' }])),
      },
    },
  };
}

export async function readStatementRows(
  llm: LlmClient,
  statement: StatementPage,
  filing: { periodEnded: string; yearEndMonthDay?: string | null },
): Promise<StatementReading> {
  const kind = STATEMENT_OF[statement.statementType];
  const items = readableItems(kind, 'statement');
  const pages = cropped(statement);
  const view = buildRows(pages);
  const base: StatementReading = {
    statementType: statement.statementType,
    basis: statement.basis,
    pages: statement.pages.map((page) => page.pageNumber),
    found: false,
    columns: [],
    unitScale: 1,
    values: [],
    mapped: 0,
    dropped: [],
    promptTokens: 0,
    completionTokens: 0,
    ms: 0,
  };
  const guide = items.map((item) => `- ${item.key}: ${item.read}`).join('\n');
  const started = Date.now();
  let reply: { found: boolean; unit: string; columns: Array<{ period_end: string; months: number }>; rows: Record<string, string> };
  try {
    const response = await llm.json<typeof reply>(
      systemPrompt(kind),
      `Label the rows of the ${TITLE[statement.statementType]}.\n\nItems:\n${guide}\n\n${view.text}`,
      schema(items),
      1_200,
    );
    reply = response.value;
    base.promptTokens = response.promptTokens;
    base.completionTokens = response.completionTokens;
  } catch (error) {
    return { ...base, ms: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : 'model call failed' };
  }
  base.ms = Date.now() - started;
  if (!reply.found) return base;

  const text = pages.map((page) => page.text).join('\n');
  const heading = pages.map((page) => page.text.split('\n').slice(0, 25).join('\n')).join('\n');
  const unitScale = unitFromText(text) ?? ({ rupees: 1, thousands: 1_000, millions: 1_000_000 } as Record<string, number>)[reply.unit] ?? 1;
  // Columns come from the printed headers, read by position (rules C1-C6): the year row fixes the
  // number of value columns and their years; each column takes the nearest date ("September 30,")
  // and period phrase ("Nine months ended", "Quarter ended") printed above it. The model's column
  // description is only a fallback for what the headers do not state.
  const inferred = inferColumns(pages, view.rows, kind);
  const count = inferred?.length ?? reply.columns.length;
  const columns: StatementReading['columns'] = [];
  for (let index = 0; index < count; index++) {
    const fromHeader = inferred?.[index];
    const fromModel = reply.columns[index];
    const monthDay = fromHeader?.monthDay ?? fromModel?.period_end.slice(4) ?? null;
    const year = fromHeader?.year ?? fromModel?.period_end.slice(0, 4) ?? null;
    // Rule C7: an interim statement that does not print its length covers the months since the
    // company's last financial year-end (the balance sheet's comparative date).
    const sinceYearEnd = year && monthDay && filing.yearEndMonthDay ? monthsSince(filing.yearEndMonthDay, monthDay) : null;
    const months = kind === 'balance' ? 0 : fromHeader?.months ?? sinceYearEnd ?? fromModel?.months ?? 0;
    if (!monthDay || !year) {
      columns.push({ periodEnd: year ?? '?', months, kept: false, reason: 'column period not stated' });
      continue;
    }
    const periodEnd = `${year}${monthDay}`;
    const reason = columnProblem(periodEnd, months, kind, heading, filing.periodEnded);
    columns.push({ periodEnd, months, kept: !reason, ...(reason ? { reason } : {}) });
  }
  // Rule C6: two value columns cannot be the same period.
  const seenPeriods = new Map<string, number>();
  for (const column of columns) seenPeriods.set(`${column.periodEnd}|${column.months}`, (seenPeriods.get(`${column.periodEnd}|${column.months}`) ?? 0) + 1);
  for (const column of columns) {
    if (column.kept && (seenPeriods.get(`${column.periodEnd}|${column.months}`) ?? 0) > 1) {
      column.kept = false;
      column.reason = 'two columns describe the same period';
    }
  }
  const place = placeRows(view.rows);

  const rowsById = new Map(view.rows.map((row) => [row.id, row]));
  const dropped: StatementReading['dropped'] = [];
  const byItem = new Map<string, Row>();
  const conflicted = new Set<string>();
  for (const [item, id] of Object.entries(reply.rows ?? {})) {
    const row = rowsById.get(id);
    if (!row) {
      dropped.push({ item, reason: `row ${id} does not exist` });
      continue;
    }
    const misfit = captionProblem(item, row, place.get(row.id));
    if (misfit) {
      dropped.push({ item, reason: `row ${id} "${row.caption || '(no caption)'}": ${misfit}` });
      continue;
    }
    const previous = byItem.get(item);
    if (previous && figuresOf(previous, columns.length).join() !== figuresOf(row, columns.length).join()) conflicted.add(item);
    else byItem.set(item, row);
  }
  for (const item of conflicted) {
    byItem.delete(item);
    dropped.push({ item, reason: 'mapped to two rows with different figures' });
  }
  // Rule R2: one row, one item (a single "basic and diluted" EPS line is the only exception).
  const itemsByRow = new Map<string, string[]>();
  for (const [item, row] of byItem) itemsByRow.set(row.id, [...(itemsByRow.get(row.id) ?? []), item]);
  for (const [rowId, items] of itemsByRow) {
    if (items.length < 2) continue;
    if (items.every((item) => item === 'eps_basic' || item === 'eps_diluted')) continue;
    for (const item of items) {
      byItem.delete(item);
      dropped.push({ item, reason: `row ${rowId} was also labelled ${items.filter((other) => other !== item).join(', ')}` });
    }
  }

  const values: ReportedValue[] = [];
  for (const [item, row] of byItem) {
    const figures = figuresOf(row, columns.length);
    if (figures.length < columns.length) {
      dropped.push({ item, reason: `row ${row.id} prints ${figures.length} figures for ${columns.length} columns` });
      continue;
    }
    for (const [index, column] of columns.entries()) {
      if (!column.kept) continue;
      const raw = figureValue(figures[index]!);
      let value = PER_SHARE.has(item) ? raw : raw * unitScale;
      if (kind === 'income' && EXPENSES.has(item)) value = Math.abs(value);
      if (value < 0 && NON_NEGATIVE.has(item)) {
        dropped.push({ item, reason: `negative for ${column.periodEnd}` });
        continue;
      }
      values.push({
        statement: kind,
        key: item,
        periodEnd: column.periodEnd,
        months: column.months,
        basis: statement.basis,
        value,
        page: row.page,
        text: row.line.replace(/\s+/gu, ' ').slice(0, 300),
      });
    }
  }

  const checked = applyIdentities(values, dropped, unitScale);
  return { ...base, found: true, columns, unitScale, values: checked, mapped: byItem.size, dropped };
}

/** Why a row cannot be this item, or null if its caption and position fit. */
function captionProblem(item: string, row: Row, where: { side?: string; section?: string; under?: string } | undefined): string | null {
  const rule = CAPTIONS[item];
  if (!rule) return null;
  if (!row.caption) {
    if (!rule.total) return 'an uncaptioned row can only be a total';
    if (rule.under && where?.under && where.under !== rule.under) return `an uncaptioned total under the ${where.under.replace(/_/gu, ' ')} heading`;
  } else {
    if (!rule.all.every((pattern) => pattern.test(row.caption))) return 'caption does not fit';
    if (rule.not?.test(row.caption)) return 'caption does not fit';
  }
  if (rule.side && where?.side && where.side !== rule.side) return `on the ${where.side} side`;
  if (rule.section && where?.section && where.section !== rule.section) return `in the ${where.section} section`;
  return null;
}

/**
 * Which side of the balance sheet (assets / equity and liabilities) and which cash flow section
 * each row sits in, from the headings printed above it. Unknown when the page has no such heading,
 * in which case position is not checked.
 */
function placeRows(rows: Row[]): Map<string, { side?: string; section?: string; under?: string }> {
  const claimsMarker = /(equity|capital)\s+and\s+liabilities|liabilities\s+and\s+(equity|capital)|share\s+capital\s+and\s+reserves/iu;
  const hasClaimsMarker = rows.some((row) => [...row.headingsBefore, row.caption].some((text) => claimsMarker.test(text)));
  let side: string | undefined = hasClaimsMarker ? 'assets' : undefined;
  let section: string | undefined;
  let under: string | undefined;
  const placed = new Map<string, { side?: string; section?: string; under?: string }>();
  for (const row of rows) {
    // Balance-sheet sub-headings ("NON-CURRENT ASSETS", "CURRENT LIABILITIES", "SHARE CAPITAL AND RESERVES").
    for (const text of row.headingsBefore) {
      if (/non-?\s?current\s+assets/iu.test(text)) under = 'non_current_assets';
      else if (/current\s+assets/iu.test(text)) under = 'current_assets';
      else if (/non-?\s?current\s+liabilities/iu.test(text)) under = 'non_current_liabilities';
      else if (/current\s+liabilities/iu.test(text)) under = 'current_liabilities';
      else if (/share\s+capital\s+and\s+reserves|^\s*equity\s*$|shareholders.?\s+equity|capital\s+and\s+reserves/iu.test(text)) under = 'equity';
    }
    for (const text of [...row.headingsBefore, row.caption]) {
      if (hasClaimsMarker && claimsMarker.test(text)) side = 'claims';
      if (/operating\s+activities/iu.test(text) && !/net\s+cash/iu.test(text)) section = 'operating';
      if (/investing\s+activities/iu.test(text) && !/net\s+cash/iu.test(text)) section = 'investing';
      if (/financing\s+activities/iu.test(text) && !/net\s+cash/iu.test(text)) section = 'financing';
    }
    placed.set(row.id, { ...(side ? { side } : {}), ...(section ? { section } : {}), ...(under ? { under } : {}) });
  }
  return placed;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAME = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b|\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/giu;
const TITLE_LINE = /^(?:for\s+the\b|as\s+(?:at|on)\b)|statement\s+of\b|\bbalance\s+sheet\b|\baccount\b/iu;
const PERIOD_PHRASE = /\b(three|3)[-\s]months?\b|\bquarter\b|\b(six|6)[-\s]months?\b|\bhalf[-\s]year|\b(nine|9)[-\s]months?\b|\b(twelve|12)[-\s]months?\b|\byear\s+ended\b/giu;

interface HeaderColumn {
  year: string;
  monthDay: string | null;
  months: number | null;
}

/**
 * Reads the column headers by position. Returns one entry per value column, or null when the
 * page has no year row. Month-day and period length are null where the headers do not state them.
 */
export function inferColumns(pages: Array<{ pageNumber: number; text: string }>, rows: Row[], kind: Statement): HeaderColumn[] | null {
  const yearRow = rows.slice(0, 12).find((row) => {
    const figures = [...row.leading, ...row.numbers];
    return figures.length >= 1 && figures.every((figure) => /^(19|20)\d{2}$/u.test(figure)) && (figures.length >= 2 || /note/iu.test(row.caption));
  });
  if (!yearRow) return null;
  const page = pages.find((candidate) => candidate.pageNumber === yearRow.page);
  if (!page) return null;
  const lines = page.text.split('\n');
  const lineIndex = lines.findIndex((line) => line.replace(/\s+/gu, ' ').trim() === yearRow.line.replace(/\s+/gu, ' ').trim());
  if (lineIndex < 0) return null;
  const yearLine = lines[lineIndex]!;
  const years: Array<{ year: string; center: number }> = [];
  for (const match of yearLine.matchAll(/(?<![\d,.])((?:19|20)\d{2})(?![\d,.])/gu)) years.push({ year: match[1]!, center: match.index! + 2 });
  if (years.length === 0) return null;

  // Column headers only: a title line ("For the nine-months period and quarter ended ...",
  // "Statement of Financial Position") names the statement, not one column, so its phrases would
  // pull the nearest column to the wrong length. The title is still read below as the fallback.
  const above = lines.slice(Math.max(0, lineIndex - 8), lineIndex).filter((line) => !TITLE_LINE.test(line.trim()));
  const dates: Array<{ monthDay: string; center: number }> = [];
  const phrases: Array<{ months: number; center: number }> = [];
  for (const line of above) {
    for (const match of line.matchAll(MONTH_NAME)) {
      const monthWord = (match[1] ?? match[4] ?? '').toLowerCase();
      const day = Number(match[2] ?? match[3]);
      const month = MONTHS.findIndex((name) => name.startsWith(monthWord.slice(0, 3))) + 1;
      if (month > 0 && day >= 1 && day <= 31) dates.push({ monthDay: `-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, center: match.index! + match[0].length / 2 });
    }
    for (const match of line.matchAll(PERIOD_PHRASE)) {
      const text = match[0].toLowerCase();
      const months = /three|3|quarter/u.test(text) ? 3 : /six|6|half/u.test(text) ? 6 : /nine|9/u.test(text) ? 9 : 12;
      phrases.push({ months, center: match.index! + match[0].length / 2 });
    }
  }
  // The statement title ("For the year ended December 31, 2023" / "As at September 30, 2023")
  // states one date and length for columns the header lines leave open.
  const title = lines.slice(0, Math.max(0, lineIndex)).join(' ');
  const titleDate = [...title.matchAll(MONTH_NAME)][0];
  const titleMonthDay = titleDate ? monthDayOf(titleDate) : null;
  const titleMonths = /year\s+ended/iu.test(title) && !/quarter|three\s+months|six\s+months|nine[-\s]months|half[-\s]year/iu.test(title) ? 12 : null;

  const nearest = <T extends { center: number }>(items: T[], x: number): T | null =>
    items.length === 0 ? null : items.reduce((best, item) => (Math.abs(item.center - x) < Math.abs(best.center - x) ? item : best));
  return years.map(({ year, center }) => ({
    year,
    monthDay: nearest(dates, center)?.monthDay ?? titleMonthDay,
    months: kind === 'balance' ? 0 : nearest(phrases, center)?.months ?? titleMonths,
  }));
}

/** Months from a year-end month-day ("-12-31") to a period end month-day ("-09-30"): 9. A year-end itself is 12. */
export function monthsSince(yearEnd: string, periodEnd: string): number {
  const endMonth = Number(yearEnd.slice(1, 3));
  const periodMonth = Number(periodEnd.slice(1, 3));
  const months = (periodMonth - endMonth + 12) % 12;
  return months === 0 ? 12 : months;
}

function monthDayOf(match: RegExpMatchArray): string | null {
  const monthWord = (match[1] ?? match[4] ?? '').toLowerCase();
  const day = Number(match[2] ?? match[3]);
  const month = MONTHS.findIndex((name) => name.startsWith(monthWord.slice(0, 3))) + 1;
  return month > 0 && day >= 1 && day <= 31 ? `-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}


/** The row's value figures: the last `count` figures printed on it (earlier ones are note references). */
function figuresOf(row: Row, count: number): string[] {
  const all = [...row.leading, ...row.numbers];
  return all.slice(Math.max(0, all.length - count));
}

function applyIdentities(values: ReportedValue[], dropped: StatementReading['dropped'], unitScale: number): ReportedValue[] {
  const remove = new Set<ReportedValue>();
  const groups = new Map<string, Map<string, ReportedValue>>();
  for (const value of values) {
    const key = `${value.periodEnd}|${value.months}`;
    const group = groups.get(key) ?? new Map<string, ReportedValue>();
    group.set(value.key, value);
    groups.set(key, group);
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.002, unitScale * 2);
  for (const [period, g] of groups) {
    const [revenue, cost, gross] = [g.get('revenue'), g.get('cost_of_sales'), g.get('gross_profit')];
    if (revenue && cost && gross && !near(revenue.value - cost.value, gross.value)) {
      [revenue, cost, gross].forEach((value) => remove.add(value));
      dropped.push({ item: 'revenue/cost_of_sales/gross_profit', reason: `revenue - cost of sales != gross profit (${period})` });
    }
    const [before, tax, after] = [g.get('profit_before_tax'), g.get('taxation'), g.get('profit_after_tax')];
    if (before && tax && after && !near(before.value - tax.value, after.value) && !near(before.value + tax.value, after.value)) {
      remove.add(tax);
      dropped.push({ item: 'taxation', reason: `profit before tax - tax != profit after tax (${period})` });
    }
    const [assets, current, nonCurrent] = [g.get('total_assets'), g.get('total_current_assets'), g.get('total_non_current_assets')];
    if (assets && current && nonCurrent && !near(current.value + nonCurrent.value, assets.value)) {
      [current, nonCurrent].forEach((value) => remove.add(value));
      dropped.push({ item: 'total_current_assets/total_non_current_assets', reason: `do not add up to total assets (${period})` });
    }
    if (assets && current && current.value > assets.value * 1.001) {
      remove.add(current);
      dropped.push({ item: 'total_current_assets', reason: `larger than total assets (${period})` });
    }
  }
  return values.filter((value) => !remove.has(value));
}

function columnProblem(periodEnd: string, months: number, kind: Statement, heading: string, filingPeriod: string): string | null {
  const date = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(date) || new Date(date).toISOString().slice(0, 10) !== periodEnd) return 'not a date';
  if (kind !== 'balance' && ![3, 6, 9, 12].includes(months)) return 'no period length';
  if (!heading.includes(periodEnd.slice(0, 4))) return `year ${periodEnd.slice(0, 4)} not in heading`;
  const reference = /^\d{4}$/u.test(filingPeriod) ? Date.parse(`${filingPeriod}-06-30T00:00:00Z`) : Date.parse(`${filingPeriod}T00:00:00Z`);
  if (!Number.isNaN(reference) && Math.abs(date - reference) > PERIOD_WINDOW_DAYS * 86_400_000) return 'too far from the filing period';
  return null;
}

export function unitFromText(text: string): number | null {
  if (/\b(?:rupees|rs\.?|pkr)\s*(?:in\s+)?(?:millions?|mn)\b|\bin\s+millions?\b/iu.test(text)) return 1_000_000;
  if (/\b(?:rupees|rs\.?|pkr)\s*(?:in\s+)?(?:thousands?|['‘’`]\s*000)\b|rupees\s+in\s+['‘’`]?\s*000|\bin\s+thousands?\b/iu.test(text)) return 1_000;
  return null;
}
