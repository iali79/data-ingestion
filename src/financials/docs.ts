import { BALANCE, CASH_FLOW, INCOME, RATIOS, type ItemDefinition } from './definitions.js';
import { RUNTIME_ITEMS } from './derive.js';
import { rulebookMarkdown } from './rulebook.js';

/**
 * Generates FINANCIALS.md (every field of the financials payload) and RULEBOOK.md from the
 * definitions and the rulebook, so the documents always match the running code.
 *   node dist/financials/docs.js
 */
const UNIT: Record<string, string> = { pkr: 'PKR', per_share: 'PKR per share', pct: 'percent', x: 'multiple', days: 'days', shares: 'shares' };

function table(items: ItemDefinition[]): string {
  const rows = items.map((item) => {
    const runtime = RUNTIME_ITEMS.find((entry) => entry.key === item.key);
    const how = item.read
      ? `Read from the ${item.from === 'note' ? 'notes' : 'statement'}: ${item.read}`
      : runtime
        ? `Runtime: 0 here, calculated by the server from the day's close (${runtime.formula})`
        : 'Calculated (formula delivered with the value)';
    return `| \`${item.key}\` | ${item.label} | ${UNIT[item.unit]} | ${how.replace(/\|/gu, '\\|')} |`;
  });
  return ['| Key | Label | Unit | Source |', '|---|---|---|---|', ...rows].join('\n');
}

const doc = `# Financials payload (schema version 2)

What the ingest webhook receives for each filing. Generated from \`src/financials/definitions.ts\`.

\`\`\`json
{
  "schemaVersion": 2,
  "taskId": "1234",
  "leaseToken": "<the lease token from the claim>",
  "extractorVersion": 5,
  "outcome": "extracted",
  "document": { "kind": "pdf", "pageCount": 114, "pagesRead": 7, "nativePages": 7, "scannedPages": 0 },
  "periods": [
    {
      "periodEnd": "2023-12-31",
      "months": 12,
      "periodType": "annual",
      "basis": "unconsolidated",
      "price": null,
      "income":   { "revenue": { "value": 21368949000, "source": "reported", "page": 46, "text": "REVENUE - NET | 24 | 21,368,949 | 18,559,884", "checks": ["A1 sum to p46.r2", "I1"] }, "gross_profit": { "value": 5526443000, "source": "derived", "formula": "revenue - cost_of_sales" }, "goodwill": null },
      "balance":  { "...": "every balance sheet key" },
      "cashFlow": { "...": "every cash flow key" },
      "ratios":   { "price_to_earnings": { "value": 0, "source": "runtime", "formula": "price / eps_basic, trailing twelve months (positive earnings only)" }, "...": "every ratio key" }
    }
  ],
  "pages": [ { "pageNumber": 46, "method": "native", "text": "..." } ],
  "log": { "timings": { "analyse": 900, "tables": 60000 }, "pagesKept": [], "statements": [], "drops": [] }
}
\`\`\`

- The filing's identity (symbol, period, document URL) is the task's, held by the server; the
  payload never states it.
- **Every key below is present in every period**, as \`{ value, source: "reported", page, text, checks }\`,
  \`{ value, source: "derived", formula }\`, \`{ value: 0, source: "runtime", formula }\` (market-based:
  the server calculates it from the day's close), or \`null\` (not printed and not derivable).
- \`log\` is what each stage did (timings, pages kept, statements read, values dropped and why), for
  the admin panel's history. It holds labels and reasons, never page text.
- \`checks\` lists the rules that confirmed a printed figure (RULEBOOK.md): \`A1\` its table adds up,
  \`I1\`/\`I2\`/\`B4\`/\`B5\`/\`F4\`/\`F5\` an accounting identity holds, \`X1\`/\`X2\` it agrees with another
  statement. A figure read by OCR is only ever delivered with at least one check.
- \`periodType\`: \`annual\` (12 months), \`nine_months\`, \`half_year\`, \`quarter\` (3 months), or
  \`balance_sheet_date\` for a balance-sheet column with no flows of its own. A filing's comparative
  columns are separate periods.
- \`basis\`: \`consolidated\`, \`unconsolidated\` or \`unknown\` (a company with no group statements).
- Money in PKR, already scaled from "Rupees in thousand". Income-statement costs are positive; a loss is
  negative. Cash-flow figures keep the printed sign (outflows negative).
- Sub-annual returns and turnovers are annualised, and say so in their formula. Earnings-based
  multiples are runtime items of 12-month periods only.

## Income statement

${table(INCOME)}

## Balance sheet

${table(BALANCE)}

## Cash flow

${table(CASH_FLOW)}

## Ratios

${table(RATIOS)}
`;

const { writeFileSync } = await import('node:fs');
writeFileSync('FINANCIALS.md', doc);
writeFileSync('RULEBOOK.md', rulebookMarkdown());
// The closed key list the ingest API validates payloads against (copied into the API's code).
const keys = (items: ItemDefinition[]) => items.map((item) => item.key);
writeFileSync(
  'financial-items.json',
  `${JSON.stringify({ schemaVersion: 2, income: keys(INCOME), balance: keys(BALANCE), cashFlow: keys(CASH_FLOW), ratios: keys(RATIOS), runtime: RUNTIME_ITEMS.map((item) => item.key) }, null, 2)}\n`,
);
console.log('wrote FINANCIALS.md, RULEBOOK.md and financial-items.json');
