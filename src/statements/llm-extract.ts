import type { LlmClient } from '../llm/client.js';
import type { StatementType } from '../parser.js';
import { compactPageText, type StatementPage } from './pages.js';

/**
 * Asks the model to read ONE statement off its page(s): what each value column means (period end
 * and length) and, for each line item we track, the values exactly as printed. The model never
 * computes or converts anything -- units, signs, scaling and every check happen in code
 * (`verify.ts`), where each figure must also be found verbatim on the page.
 */
export interface ModelColumn {
  period_end: string;
  months: number;
}

export interface ModelItem {
  item: string;
  values: Array<string | null>;
}

export interface ModelReading {
  found: boolean;
  unit: 'rupees' | 'thousands' | 'millions';
  columns: ModelColumn[];
  items: ModelItem[];
}

/** What each tracked item means, in the words PSX filings use. Order is the usual print order. */
export const ITEM_GUIDE: Record<StatementType, Array<[string, string]>> = {
  income_statement: [
    ['revenue', 'Revenue / net sales / turnover (the net figure)'],
    ['cost_of_sales', 'Cost of sales / cost of revenue / cost of goods sold'],
    ['gross_profit', 'Gross profit (or gross loss)'],
    ['distribution_cost', 'Distribution / selling / marketing costs'],
    ['admin_expenses', 'Administrative (and general) expenses'],
    ['selling_admin_expenses', 'ONLY a single combined "selling and administrative expenses" line'],
    ['rd_expenses', 'Research and development expenses'],
    ['other_operating_expenses', 'Other (operating) expenses'],
    ['other_income', 'Other (operating) income'],
    ['operating_expenses', 'Total operating expenses, when printed as its own labelled line'],
    ['operating_profit', 'Operating profit / profit from operations'],
    ['depreciation_amortization', 'Depreciation and amortisation, only if printed on this statement'],
    ['interest_income', 'Interest / markup income, return on deposits'],
    ['finance_cost', 'Finance cost / markup / financial charges'],
    ['profit_before_tax', 'Profit before taxation. If levies are shown separately, the profit AFTER levies and BEFORE income tax'],
    ['taxation', 'Income tax for the period. If split into current/prior/deferred, the TOTAL of those lines'],
    ['profit_after_tax', 'Profit / (loss) for the year or period'],
    ['preferred_dividends', 'Dividend on preference shares'],
    ['eps_basic', 'Earnings per share - basic (also use this when one line says "basic and diluted")'],
    ['eps_diluted', 'Earnings per share - diluted, ONLY when printed as its own line'],
  ],
  balance_sheet: [
    ['property_plant_equipment', 'Property, plant and equipment'],
    ['stock_in_trade', 'Stock-in-trade / inventories'],
    ['trade_debts', 'Trade debts / trade receivables'],
    ['cash_and_bank', 'Cash and bank balances / cash and cash equivalents'],
    ['current_assets', 'Total current assets'],
    ['total_assets', 'Total assets'],
    ['share_capital', 'Issued, subscribed and paid-up (share) capital'],
    ['retained_earnings', 'Unappropriated profit / retained earnings / accumulated profit or loss'],
    ['non_controlling_interest', 'Non-controlling interest'],
    ['total_equity', 'Total equity / total shareholders’ equity'],
    ['long_term_debt', 'Long-term financing / long-term borrowings (non-current)'],
    ['short_term_borrowings', 'Short-term borrowings / running finance'],
    ['trade_and_other_payables', 'Trade and other payables'],
    ['current_liabilities', 'Total current liabilities'],
    ['total_liabilities', 'Total liabilities, only when printed as its own line'],
  ],
  cash_flow: [
    ['operating_cash_flow', 'Net cash generated from / (used in) operating activities'],
    ['capital_expenditure', 'Purchase of / additions to property, plant and equipment (fixed capital expenditure)'],
    ['investing_cash_flow', 'Net cash used in / from investing activities'],
    ['dividend_paid', 'Dividends paid'],
    ['financing_cash_flow', 'Net cash used in / from financing activities'],
  ],
};

const STATEMENT_NAMES: Record<StatementType, string> = {
  income_statement: 'statement of profit or loss (income statement)',
  balance_sheet: 'statement of financial position (balance sheet)',
  cash_flow: 'statement of cash flows',
};

const SYSTEM = [
  'You read financial statements of Pakistani listed companies and copy figures out of them exactly.',
  'Rules:',
  '- Copy each value exactly as printed, including commas, parentheses and "-" for nil. Never calculate, round, convert or guess a value.',
  '- columns: the value columns of the requested statement, left to right. Skip the "Note" column.',
  '  period_end: the date the column’s period ends, YYYY-MM-DD, from the headings (e.g. "For the year ended December 31, 2023" + column "2022" means 2022-12-31).',
  '  months: length of the period for profit or loss and cash flow columns (3 for a quarter, 6 half year, 9 nine months, 12 year); 0 for balance sheet columns.',
  '- items: only the listed items that are printed for the requested statement. values has one entry per column, in column order; null if that cell is blank.',
  '- A page may show two statements side by side. Read only the requested one.',
  '- unit: from the heading, e.g. "(Rupees in thousand)" or "Rupees in ’000" -> thousands; "Rupees in million" -> millions; plain rupees -> rupees.',
  '- found: false if the requested statement is not on the page.',
].join('\n');

export function readingSchema(type: StatementType): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['found', 'unit', 'columns', 'items'],
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
      items: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'values'],
          properties: {
            item: { type: 'string', enum: ITEM_GUIDE[type].map(([item]) => item) },
            values: { type: 'array', maxItems: 6, items: { type: ['string', 'null'], maxLength: 24 } },
          },
        },
      },
    },
  };
}

export function readingPrompt(statement: StatementPage): string {
  const guide = ITEM_GUIDE[statement.statementType].map(([item, meaning]) => `- ${item}: ${meaning}`).join('\n');
  const pages = statement.pages.map((page) => `--- page ${page.pageNumber} ---\n${compactPageText(page.text)}`).join('\n');
  return `Read the ${STATEMENT_NAMES[statement.statementType]} on this page.\n\nItems:\n${guide}\n\n${pages}`;
}

export async function readStatement(
  llm: LlmClient,
  statement: StatementPage,
): Promise<{ reading: ModelReading; promptTokens: number; completionTokens: number; ms: number }> {
  const started = Date.now();
  const { value, promptTokens, completionTokens } = await llm.json<ModelReading>(
    SYSTEM,
    readingPrompt(statement),
    readingSchema(statement.statementType),
    1_500,
  );
  return { reading: value, promptTokens, completionTokens, ms: Date.now() - started };
}
