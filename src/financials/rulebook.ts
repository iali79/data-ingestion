/**
 * The rulebook: the fixed rules every delivered figure obeys, each with an id, the pipeline stage
 * that enforces it, and how. The rule ids appear in the output -- a reported figure lists the
 * checks that confirmed it ("A1", "I2", "X2"), and every dropped value names the rule that
 * dropped it -- so a figure can be traced to the rules it passed. RULEBOOK.md is generated from
 * this file (`npm run docs`), so the document and the running rules cannot differ.
 */
export interface Rule {
  id: string;
  stage: 'classify' | 'tables' | 'normalize' | 'labels' | 'verify' | 'validate' | 'notes' | 'derive';
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
  { id: 'V1', stage: 'normalize', text: 'A figure is taken only from a printed table cell. Nothing is typed, estimated or completed; the only correction is R7, a misread the arithmetic proves.', enforced: 'parseFigure: an unreadable cell is null; repair.ts is the only place a reading is replaced.' },
  { id: 'V1b', stage: 'normalize', text: 'A cell holding two figures ("8 45,533,482", "- 1,289": two printed lines fused, or a digit lost from a group) is unreadable. The figures are never glued into one number.', enforced: 'fusedFigures in normalize.ts.' },
  { id: 'V2', stage: 'normalize', text: 'A dash or "Nil" in a value column means nil (zero).', enforced: 'parseFigure.' },
  { id: 'V3', stage: 'normalize', text: 'Figures in brackets are negative, including one whose opening or closing bracket OCR lost; so is a figure after a minus sign (hyphen or U+2212).', enforced: 'parseFigure.' },
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
  { id: 'C9', stage: 'normalize', text: 'A header naming two lengths ("Year Ended Quarter", two spanning headers merged) gives its column no length; and when any column prints its own length, a column that prints none is not given one from the title or the year-end (a half-year filing\u2019s quarter columns would otherwise read as six months).', enforced: 'describeColumns and periodPhrases in normalize.ts.' },
  { id: 'C8', stage: 'normalize', text: 'In an annual filing, a column that prints only its year ends at the financial year-end (from the balance sheet) and covers 12 months. Never applied to interim filings.', enforced: 'describeColumns.' },
  // --- labels -------------------------------------------------------------------------------------
  { id: 'R1', stage: 'labels', text: 'A row is an item only when its printed label matches that item’s wording. Similar is not enough: reserves are not retained earnings, intangible assets are not goodwill. Unmatched rows are reported, not guessed.', enforced: 'LABEL_RULES in labels.ts, specific wording first.' },
  { id: 'R2', stage: 'labels', text: 'A row is one item, except one "basic and diluted" EPS line, which is both.', enforced: 'matchRows.' },
  { id: 'R3', stage: 'labels', text: 'An uncaptioned total belongs to the heading it closes only when the captioned rows under that heading add up to it (the last such row, so a "fixed assets" subtotal is not the non-current assets, and a grand total printed after "Contingencies" is not the current liabilities); authorised capital is not part of equity. On the income statement, an uncaptioned total directly below split tax lines is the taxation.', enforced: 'uncaptionedTotal and addsUpUnder in labels.ts.' },
  { id: 'R5', stage: 'validate', text: 'An item printed on two rows with different figures is ambiguous and not delivered.', enforced: 'valuesFromMatches.' },
  { id: 'R6', stage: 'labels', text: 'Items must sit where they belong: assets above "EQUITY AND LIABILITIES", equity and liabilities below; cash flow items in their operating, investing or financing section.', enforced: 'placeRows and the side/section/under conditions of each label rule.' },
  // --- reviewer hints -----------------------------------------------------------------------------
  { id: 'H0', stage: 'classify', text: 'A reviewer\u2019s hints for a filing are used only when every part is well-formed for the document (known keys, a listed unit, statement pages within the document in ascending order); otherwise none of them is used.', enforced: 'readHints in hints.ts.' },
  { id: 'H1', stage: 'classify', text: 'Hints replace a decision the pipeline would make on its own (where a statement is, which unit it is in) and nothing else: every other rule still applies and the checks still decide what is delivered.', enforced: 'hints.ts; the hinted statement and its pages are recorded in the statement\u2019s problems and the page reasons.' },
  { id: 'H2', stage: 'classify', text: 'A hinted statement replaces the classifier\u2019s pages for its type: for its basis when the hint names one (and statements whose basis was not read), otherwise for every basis.', enforced: 'applyPageHints in hints.ts.' },
  { id: 'H3', stage: 'normalize', text: 'A hinted unit applies to every statement of the filing, whatever unit it printed or inherited.', enforced: 'applyUnitHint in hints.ts, after inheritUnits.' },
  // --- units and signs ----------------------------------------------------------------------------
  { id: 'U1', stage: 'normalize', text: 'Figures are scaled by the unit the page states ("Rupees in ’000" is x1,000). A statement that prints no unit takes the unit of the filing\u2019s other statements when they all agree.', enforced: 'unitFromText over the header, title and first rows; inheritUnits in filing.ts.' },
  { id: 'U2', stage: 'validate', text: 'Earnings per share is rupees per share and is never scaled.', enforced: 'PER_SHARE.' },
  { id: 'U3', stage: 'validate', text: 'Income-statement expenses are delivered as positive amounts, except a tax or levy credit, which I2 or I4 shows to be one and which is delivered negative; cash flow figures keep their printed sign.', enforced: 'EXPENSES; applyChecks delivers a credit negative when its identity holds only with the credit sign.' },
  { id: 'U4', stage: 'validate', text: 'Items that cannot be negative (revenue, total assets, cash, proceeds from selling assets or investments, ...) are dropped when read negative.', enforced: 'NON_NEGATIVE.' },
  // --- checks -------------------------------------------------------------------------------------
  { id: 'A1', stage: 'validate', text: 'Every printed total must equal the rows above it, column by column (to rounding). Rows in a sum that adds up are confirmed. A run of rows found to add up in one column is also checked in every other kept column, so a total with one misread component is caught, not just left unconfirmed.', enforced: 'confirmTotals; A1 constraints in constraints.ts; the confirming total is listed in the figure\u2019s checks.' },
  { id: 'I1', stage: 'validate', text: 'Revenue - cost of sales = gross profit.', enforced: 'constraints.ts; on failure all three are dropped.' },
  { id: 'I2', stage: 'validate', text: 'Profit before tax - taxation = profit after tax (a tax credit adds).', enforced: 'constraints.ts; on failure all three are dropped.' },
  { id: 'I3', stage: 'validate', text: 'Profit attributable to owners + to non-controlling interest = profit after tax.', enforced: 'constraints.ts.' },
  { id: 'I4', stage: 'validate', text: 'Levies: profit before levies and income tax - levies = profit before income tax (levies above profit before tax), or profit before tax - levies - taxation = profit after tax (levies below it). Only when every row between is a levy line.', enforced: 'constraints.ts.' },
  { id: 'I5', stage: 'validate', text: 'Gross profit - distribution - administrative - other operating expenses + other income = operating profit, only when those are exactly the rows printed between the two.', enforced: 'constraints.ts.' },
  { id: 'B1', stage: 'validate', text: 'Total assets = total equity + total liabilities.', enforced: 'constraints.ts.' },
  { id: 'B2', stage: 'validate', text: 'Current + non-current liabilities = total liabilities.', enforced: 'constraints.ts.' },
  { id: 'B3', stage: 'validate', text: 'Equity attributable to owners + non-controlling interest = total equity.', enforced: 'constraints.ts.' },
  { id: 'B4', stage: 'validate', text: 'Current + non-current assets = total assets.', enforced: 'constraints.ts.' },
  { id: 'B5', stage: 'validate', text: 'Total assets = the printed total equity and liabilities.', enforced: 'constraints.ts.' },
  { id: 'F4', stage: 'validate', text: 'Operating + investing + financing cash flows = net change in cash.', enforced: 'constraints.ts.' },
  { id: 'F5', stage: 'validate', text: 'Opening cash + net change (+ exchange differences) = closing cash.', enforced: 'constraints.ts.' },
  { id: 'X1', stage: 'validate', text: 'The cash flow\u2019s profit before tax equals the income statement\u2019s for the same period (a confirmation when it holds; a difference drops nothing, since levies can sit between them).', enforced: 'constraints.ts, advisory.' },
  { id: 'X3', stage: 'validate', text: 'A cash flow that starts from profit after tax starts from the income statement\u2019s.', enforced: 'constraints.ts.' },
  { id: 'X4', stage: 'validate', text: 'The cash flow\u2019s closing cash equals the balance sheet\u2019s cash (or cash less short-term borrowings and overdrafts, whichever the filing uses).', enforced: 'constraints.ts; advisory when neither form holds.' },
  { id: 'X5', stage: 'validate', text: 'The same item printed in two tables of the same statement, basis and period agrees.', enforced: 'constraints.ts.' },
  { id: 'E1', stage: 'validate', text: 'Earnings per share: profit attributable to owners over EPS gives the same share count in every column of the statement (to EPS rounding). EPS below 0.10 is too coarse to check.', enforced: 'confirmEps in validate.ts.' },
  { id: 'Adv', stage: 'validate', text: 'An identity is advisory (a failure drops nothing) when the statement prints a line it leaves out: assets held for sale, cash from an amalgamation, an IFRS 9 adjustment, a discontinued operation.', enforced: 'constraints.ts marks it advisory.' },
  { id: 'V6', stage: 'validate', text: 'A figure is delivered only when at least one relation above confirms it, whether it was read from a text layer or by OCR. A figure no arithmetic touches is not verified and is not delivered.', enforced: 'applyChecks.' },
  // --- verify and repair ------------------------------------------------------------------------------
  { id: 'R7', stage: 'verify', text: 'A failing relation means a misread cell. Its cells get a second, independent reading (the page\u2019s text layer, or a 300 dpi OCR of a scanned page). A reading is replaced only by a plausible misread of the printed text (one OCR digit confusion, a lost bracket, a dropped or extra digit, a comma read as a point, one figure of two fused) or by the second reading, and only when: every relation containing the cell then holds; two independent relations are closed by it, or one and the second reading agrees; no other correction would do; and nothing that held before breaks.', enforced: 'repair.ts (R7a-R7g); the figure\u2019s checks list "R7 corrected from" the first reading.' },
  { id: 'S1-S9', stage: 'derive', text: 'Plausibility (gross margin at most 100%, parts within their totals, EPS x shares near profit, ...) is reported for review in the log, never used to drop or repair: minimum tax and bonus issues make real exceptions.', enforced: 'ratioProblems in constraints.ts.' },
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
