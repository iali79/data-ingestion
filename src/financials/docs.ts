import { BALANCE, CASH_FLOW, INCOME, RATIOS, type ItemDefinition } from './definitions.js';
import { rulebookMarkdown } from './rulebook.js';

/**
 * Generates FINANCIALS.md (every field of the financials payload) and RULEBOOK.md from the
 * definitions and the rulebook, so the documents always match the running code.
 *   node dist/financials/docs.js
 */
const UNIT: Record<string, string> = { pkr: 'PKR', per_share: 'PKR per share', pct: 'percent', x: 'multiple', days: 'days', shares: 'shares' };

function table(items: ItemDefinition[]): string {
  const rows = items.map((item) => {
    const how = item.read ? `Read from the ${item.from === 'note' ? 'notes' : 'statement'}: ${item.read}` : 'Calculated (formula delivered with the value)';
    return `| \`${item.key}\` | ${item.label} | ${UNIT[item.unit]} | ${how.replace(/\|/gu, '\\|')} |`;
  });
  return ['| Key | Label | Unit | Source |', '|---|---|---|---|', ...rows].join('\n');
}

const doc = `# Financials payload (schema version 2)

What the ingest webhook receives for each filing. Generated from \`src/financials/definitions.ts\`.

\`\`\`json
{
  "schemaVersion": 2,
  "extractorVersion": 3,
  "filing": { "symbol": "HPL", "reportType": "annual", "periodEnded": "2023", "sourceUrl": "https://financials.psx.com.pk/..." },
  "document": { "kind": "pdf", "pageCount": 114, "pagesRead": 7, "nativePages": 7, "scannedPages": 0 },
  "periods": [
    {
      "periodEnd": "2023-12-31",
      "months": 12,
      "periodType": "annual",
      "basis": "unconsolidated",
      "price": { "close": 1200, "date": "2023-12-29", "source": "PSX end-of-day close" },
      "income":   { "revenue": { "value": 21368949000, "source": "reported", "page": 46, "text": "REVENUE - NET | 24 | 21,368,949 | 18,559,884", "checks": ["A1 sum to p46.r2", "I1"] }, "gross_profit": { "value": 5526443000, "source": "derived", "formula": "revenue - cost_of_sales" }, "goodwill": null },
      "balance":  { "...": "every balance sheet key" },
      "cashFlow": { "...": "every cash flow key" },
      "ratios":   { "...": "every ratio key" }
    }
  ],
  "pages": [ { "pageNumber": 46, "method": "pdftotext", "text": "..." } ]
}
\`\`\`

- **Every key below is present in every period**, as \`{ value, source: "reported", page, text, checks }\`,
  \`{ value, source: "derived", formula }\`, or \`null\` (not printed and not derivable).
- \`checks\` lists the rules that confirmed a printed figure (RULEBOOK.md): \`A1\` its table adds up,
  \`I1\`/\`I2\`/\`B4\`/\`B5\`/\`F4\`/\`F5\` an accounting identity holds, \`X1\`/\`X2\` it agrees with another
  statement. A figure read by OCR is only ever delivered with at least one check.
- \`periodType\`: \`annual\` (12 months), \`nine_months\`, \`half_year\`, \`quarter\` (3 months), or
  \`balance_sheet_date\` for a balance-sheet column with no flows of its own. A filing's comparative
  columns are separate periods.
- \`basis\`: \`consolidated\`, \`unconsolidated\` or \`unknown\` (a company with no group statements).
- Money in PKR, already scaled from "Rupees in thousand". Income-statement costs are positive; a loss is
  negative. Cash-flow figures keep the printed sign (outflows negative).
- Sub-annual returns and turnovers are annualised, and say so in their formula. Price multiples use the
  PSX close on or just before the period end; earnings multiples are given for 12-month periods only.

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
console.log('wrote FINANCIALS.md and RULEBOOK.md');
