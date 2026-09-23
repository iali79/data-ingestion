/**
 * The rulebook: the fixed rules every delivered figure obeys, each with an id, the pipeline stage
 * that enforces it, and how. The rule ids appear in the output -- a reported figure lists the
 * checks that confirmed it ("A1", "I2", "X2"), and every dropped value names the rule that
 * dropped it -- so a figure can be traced to the rules it passed. RULEBOOK.md is generated from
 * this file (`npm run docs`), so the document and the running rules cannot differ.
 */
export interface Rule {
  id: string;
  stage: 'classify' | 'tables' | 'normalize' | 'labels' | 'validate' | 'notes' | 'derive';
  text: string;
  /** Where and how the code enforces it. */
  enforced: string;
}

export const RULES: Rule[] = [
  // --- pages ------------------------------------------------------------------------------------
  { id: 'P1', stage: 'classify', text: 'Only recognised pages are read: the income statement, balance sheet and cash flow per consolidation basis, and the notes the balance sheet cites. Everything else -- reviews, charts, "years at a glance", auditors’ reports -- is never extracted.', enforced: 'classify.ts selects pages positively; every page records why it was kept or dropped.' },
  { id: 'P2', stage: 'classify', text: 'A statement title counts only as a heading: alone on its line or followed by its period ("as at ...", "for the year ended ..."). A title inside a sentence (an auditor’s report listing the statements) does not.', enforced: 'TITLE_TAIL in classify.ts.' },
  { id: 'P3', stage: 'classify', text: 'A native statement page must print its own captions and figures; a scanned page’s title strip must show figures, a year header or a statement caption.', enforced: 'ANCHORS, figure-line count and YEAR_HEADER in classify.ts.' },
  { id: 'P4', stage: 'classify', text: 'A note is the one the balance sheet cites by number ("Stock-in-trade 9" -> note 9); without a citation only a whole-numbered heading counts (2.3 is an accounting policy, not a note).', enforced: 'noteReferences and noteHeading in classify.ts.' },
  // --- reading tables ---------------------------------------------------------------------------
  { id: 'T1', stage: 'tables', text: 'A native page is read from its text layer; a scanned page is read from its image by OCR, never from a partial text overlay.', enforced: 'subset.ts renders scanned pages to 300 dpi images; docstage OCRs only those.' },
  { id: 'V1', stage: 'normalize', text: 'A figure is taken only from a printed table cell. Nothing is typed, estimated or completed.', enforced: 'parseFigure: an unreadable cell is null, never repaired beyond trimming OCR residue.' },
  { id: 'V2', stage: 'normalize', text: 'A dash in a value column means nil (zero).', enforced: 'parseFigure.' },
  { id: 'V3', stage: 'normalize', text: 'Figures in brackets are negative.', enforced: 'parseFigure.' },
  { id: 'V4', stage: 'normalize', text: 'The note column holds references, not values.', enforced: 'columnLayout sets the note column aside.' },
  { id: 'R4', stage: 'normalize', text: 'One printed line split across two table rows (part of the label and part of the figures on each) is one row.', enforced: 'mergeSplitRows, only when the two rows’ figures do not overlap and together fill every column.' },
  { id: 'R4b', stage: 'normalize', text: 'Two printed lines fused into one table row (each cell holding both lines\u2019 figures) are two rows, when every cell holds exactly two figures and the second label starts a total ("Net cash ...", "Total ...").', enforced: 'splitFusedRows; the split rows still pass the arithmetic checks.' },
  // --- columns and periods ------------------------------------------------------------------------
  { id: 'C1', stage: 'normalize', text: 'Each value column is dated by its printed header; the year must be printed.', enforced: 'describeColumns.' },
  { id: 'C2', stage: 'normalize', text: 'A column’s date must be within 18 months of the filing’s period.', enforced: 'columnProblem.' },
  { id: 'C3', stage: 'normalize', text: 'Flow columns cover 3, 6, 9 or 12 months; balance-sheet columns are a date.', enforced: 'columnProblem.' },
  { id: 'C4', stage: 'normalize', text: 'Year-to-date and quarter columns each take the length printed over them ("Nine months ended", "Quarter ended").', enforced: 'describeColumns reads each column’s own header.' },
  { id: 'C5', stage: 'normalize', text: 'Where a header prints only the year, the date and length come from the statement title ("For the year ended December 31, 2023").', enforced: 'describeColumns.' },
  { id: 'C6', stage: 'normalize', text: 'Two value columns never describe the same period; if they do, neither is used.', enforced: 'describeColumns.' },
  { id: 'C7', stage: 'normalize', text: 'An interim column that does not print its length covers the months since the financial year-end, read from the balance sheet’s comparative column.', enforced: 'monthsSince in conventions.ts.' },
  { id: 'C8', stage: 'normalize', text: 'In an annual filing, a column that prints only its year ends at the financial year-end (from the balance sheet) and covers 12 months. Never applied to interim filings.', enforced: 'describeColumns.' },
  // --- labels -------------------------------------------------------------------------------------
  { id: 'R1', stage: 'labels', text: 'A row is an item only when its printed label matches that item’s wording. Similar is not enough: reserves are not retained earnings, intangible assets are not goodwill. Unmatched rows are reported, not guessed.', enforced: 'LABEL_RULES in labels.ts, specific wording first.' },
  { id: 'R2', stage: 'labels', text: 'A row is one item, except one "basic and diluted" EPS line, which is both.', enforced: 'matchRows.' },
  { id: 'R3', stage: 'labels', text: 'An uncaptioned total belongs to the heading it closes (the last one under "CURRENT ASSETS" is total current assets), or on the income statement to the split tax lines directly above it.', enforced: 'uncaptionedTotal in labels.ts.' },
  { id: 'R5', stage: 'validate', text: 'An item printed on two rows with different figures is ambiguous and not delivered.', enforced: 'valuesFromMatches.' },
  { id: 'R6', stage: 'labels', text: 'Items must sit where they belong: assets above "EQUITY AND LIABILITIES", equity and liabilities below; cash flow items in their operating, investing or financing section.', enforced: 'placeRows and the side/section/under conditions of each label rule.' },
  // --- units and signs ----------------------------------------------------------------------------
  { id: 'U1', stage: 'normalize', text: 'Figures are scaled by the unit the page states ("Rupees in ’000" is x1,000). A statement that prints no unit takes the unit of the filing\u2019s other statements when they all agree.', enforced: 'unitFromText over the header, title and first rows; inheritUnits in filing.ts.' },
  { id: 'U2', stage: 'validate', text: 'Earnings per share is rupees per share and is never scaled.', enforced: 'PER_SHARE.' },
  { id: 'U3', stage: 'validate', text: 'Income-statement expenses are delivered as positive amounts; cash flow figures keep their printed sign.', enforced: 'EXPENSES.' },
  { id: 'U4', stage: 'validate', text: 'Items that cannot be negative (revenue, total assets, cash, ...) are dropped when read negative.', enforced: 'NON_NEGATIVE.' },
  // --- checks -------------------------------------------------------------------------------------
  { id: 'A1', stage: 'validate', text: 'Every printed total must equal the rows above it, column by column (to rounding). Rows in a sum that adds up are confirmed.', enforced: 'confirmTotals; the confirming total is listed in the figure’s checks.' },
  { id: 'I1', stage: 'validate', text: 'Revenue - cost of sales = gross profit.', enforced: 'IDENTITIES; on failure all three are dropped.' },
  { id: 'I2', stage: 'validate', text: 'Profit before tax - taxation = profit after tax.', enforced: 'IDENTITIES; on failure all three are dropped.' },
  { id: 'B4', stage: 'validate', text: 'Current + non-current assets = total assets.', enforced: 'IDENTITIES.' },
  { id: 'B5', stage: 'validate', text: 'Total assets = the printed total equity and liabilities.', enforced: 'applyChecks.' },
  { id: 'F4', stage: 'validate', text: 'Operating + investing + financing cash flows = net change in cash.', enforced: 'IDENTITIES.' },
  { id: 'F5', stage: 'validate', text: 'Opening cash + net change (+ exchange differences) = closing cash.', enforced: 'IDENTITIES.' },
  { id: 'X1', stage: 'validate', text: 'The cash flow’s profit before tax equals the income statement’s for the same period (recorded as a confirmation; a difference is reported, since levies can sit between them).', enforced: 'applyChecks.' },
  { id: 'V5', stage: 'validate', text: 'A figure read by OCR is delivered only when at least one check (A1, an identity, B5, X1) confirms it.', enforced: 'applyChecks.' },
  // --- notes --------------------------------------------------------------------------------------
  { id: 'X2', stage: 'notes', text: 'The inventory split (raw material, work-in-process, finished goods) is delivered only when the note’s lines add up to its total and that total equals the balance sheet’s stock-in-trade.', enforced: 'reconcile in notes.ts.' },
  // --- calculation --------------------------------------------------------------------------------
  { id: 'D1', stage: 'derive', text: 'A figure that is not printed is calculated only when every input of its formula is available; the formula is delivered with it. Otherwise it is null.', enforced: 'derive.ts.' },
  { id: 'D2', stage: 'derive', text: 'Average-based ratios need the balance sheet at the start of the period; sub-annual returns and turnovers are annualised (x 12 / months) and say so.', enforced: 'derive.ts.' },
  { id: 'D3', stage: 'derive', text: 'Price multiples use the PSX closing price on or just before the period end; earnings multiples only 12-month periods.', enforced: 'derive.ts, price.ts.' },
];

export function rulebookMarkdown(): string {
  const lines = [
    '# Rulebook',
    '',
    'Fixed rules every delivered figure obeys. Each is enforced in code at the stage named; a',
    'reported figure lists the checks that confirmed it, and every dropped value names the rule that',
    'dropped it. Generated from `src/financials/rulebook.ts` (`npm run docs`); edit that file, not this one.',
    '',
    '| Id | Stage | Rule | Enforced |',
    '|---|---|---|---|',
    ...RULES.map((rule) => `| ${rule.id} | ${rule.stage} | ${rule.text.replace(/\|/gu, '\\|')} | ${rule.enforced.replace(/\|/gu, '\\|')} |`),
    '',
  ];
  return lines.join('\n');
}
