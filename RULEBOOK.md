# Rulebook

Fixed rules every delivered figure obeys. Each is enforced in code at the stage named; a
reported figure lists the checks that confirmed it, and every dropped value names the rule that
dropped it. Generated from `src/financials/rulebook.ts` (`npm run docs`); edit that file, not this one.

| Id | Stage | Rule | Enforced |
|---|---|---|---|
| P1 | classify | Only recognised pages are read: the income statement, balance sheet and cash flow per consolidation basis, and the notes the balance sheet cites. Everything else -- reviews, charts, "years at a glance", auditors’ reports -- is never extracted. | classify.ts selects pages positively; every page records why it was kept or dropped. |
| P2 | classify | A statement title counts only as a heading: alone on its line or followed by its period ("as at ...", "for the year ended ..."). A title inside a sentence (an auditor’s report listing the statements) does not. | TITLE_TAIL in classify.ts. |
| P3 | classify | A native statement page must print its own captions and figures; a scanned page’s title strip must show figures, a year header or a statement caption. | ANCHORS, figure-line count and YEAR_HEADER in classify.ts. |
| P4 | classify | A note is the one the balance sheet cites by number ("Stock-in-trade 9" -> note 9); without a citation only a whole-numbered heading counts (2.3 is an accounting policy, not a note). | noteReferences and noteHeading in classify.ts. |
| T1 | tables | A native page is read from its text layer; a scanned page is read from its image by OCR, never from a partial text overlay. | subset.ts renders scanned pages to 300 dpi images; docstage OCRs only those. |
| V1 | normalize | A figure is taken only from a printed table cell. Nothing is typed, estimated or completed. | parseFigure: an unreadable cell is null, never repaired beyond trimming OCR residue. |
| V2 | normalize | A dash or "Nil" in a value column means nil (zero). | parseFigure. |
| V3 | normalize | Figures in brackets are negative, including one whose opening or closing bracket OCR lost; so is a figure after a minus sign (hyphen or U+2212). | parseFigure. |
| V4 | normalize | The note column holds references, not values. | columnLayout sets the note column aside. |
| R4 | normalize | One printed line split across two table rows (part of the label and part of the figures on each) is one row. | mergeSplitRows, only when the two rows’ figures do not overlap and together fill every column. |
| R4b | normalize | Printed lines fused into one table row (each cell holding every line’s figures), where R4c could not read them from a text layer, are split from the row itself: two lines when every cell holds exactly two figures and the second label starts a total ("Net cash ...", "Total ..."); on a scanned page, k lines (two to four) when every cell holds exactly k figures and the label has exactly k - 1 places where a new caption can start (a capitalised word not after a connecting word). Anything less certain is left unreadable. | splitFusedRows in normalize.ts; the split rows still pass the arithmetic checks. |
| R4c | normalize | On a page with a text layer, rows the table model fused, or whose figures or captions it shifted by a line, are rebuilt as the printed lines: only when the block’s figures, read down each column, are exactly those of a run of consecutive lines, and its captions and headings are those lines’ words. Nothing else is rebuilt; no figure is changed, only moved to the line the page prints it on. | rebuildFromText in fused.ts, before R4b and R4; the rebuilt rows still pass the arithmetic checks. |
| C1 | normalize | Each value column is dated by its printed header; the year must be printed. | describeColumns. |
| C2 | normalize | A column’s date must be within 18 months of the filing’s period. | columnProblem. |
| C3 | normalize | Flow columns cover 3, 6, 9 or 12 months; balance-sheet columns are a date. | columnProblem. |
| C4 | normalize | Year-to-date and quarter columns each take the length printed over them ("Nine months ended", "Quarter ended"). | describeColumns reads each column’s own header. |
| C5 | normalize | Where a header prints only the year, the date and length come from the statement title ("For the year ended December 31, 2023"). | describeColumns. |
| C6 | normalize | Two value columns never describe the same period; if they do, neither is used. | describeColumns. |
| C7 | normalize | An interim column that does not print its length covers the months since the financial year-end, read from the balance sheet’s comparative column. | monthsSince in conventions.ts. |
| C8 | normalize | In an annual filing, a column that prints only its year ends at the financial year-end (from the balance sheet) and covers 12 months. Never applied to interim filings. | describeColumns. |
| R1 | labels | A row is an item only when its printed label matches that item’s wording. Similar is not enough: reserves are not retained earnings, intangible assets are not goodwill. Unmatched rows are reported, not guessed. | LABEL_RULES in labels.ts, specific wording first. |
| R2 | labels | A row is one item, except one "basic and diluted" EPS line, which is both. | matchRows. |
| R3 | labels | An uncaptioned total belongs to the heading it closes only when the captioned rows under that heading add up to it (the last such row, so a "fixed assets" subtotal is not the non-current assets, and a grand total printed after "Contingencies" is not the current liabilities); authorised capital is not part of equity. On the income statement, an uncaptioned total directly below split tax lines is the taxation. | uncaptionedTotal and addsUpUnder in labels.ts. |
| R5 | validate | An item printed on two rows with different figures is ambiguous and not delivered. | valuesFromMatches. |
| R6 | labels | Items must sit where they belong: assets above "EQUITY AND LIABILITIES", equity and liabilities below; cash flow items in their operating, investing or financing section. | placeRows and the side/section/under conditions of each label rule. |
| H0 | classify | A reviewer’s hints for a filing are used only when every part is well-formed for the document (known keys, a listed unit, statement pages within the document in ascending order); otherwise none of them is used. | readHints in hints.ts. |
| H1 | classify | Hints replace a decision the pipeline would make on its own (where a statement is, which unit it is in) and nothing else: every other rule still applies and the checks still decide what is delivered. | hints.ts; the hinted statement and its pages are recorded in the statement’s problems and the page reasons. |
| H2 | classify | A hinted statement replaces the classifier’s pages for its type: for its basis when the hint names one (and statements whose basis was not read), otherwise for every basis. | applyPageHints in hints.ts. |
| H3 | normalize | A hinted unit applies to every statement of the filing, whatever unit it printed or inherited. | applyUnitHint in hints.ts, after inheritUnits. |
| U1 | normalize | Figures are scaled by the unit the page states ("Rupees in ’000" is x1,000). A statement that prints no unit takes the unit of the filing’s other statements when they all agree. | unitFromText over the header, title and first rows; inheritUnits in filing.ts. |
| U2 | validate | Earnings per share is rupees per share and is never scaled. | PER_SHARE. |
| U3 | validate | Income-statement expenses are delivered as positive amounts, except a tax credit, which I2 shows to be one and which is delivered negative; cash flow figures keep their printed sign. | EXPENSES; I2 in validate.ts reverses a confirmed tax credit. |
| U4 | validate | Items that cannot be negative (revenue, total assets, cash, proceeds from selling assets or investments, ...) are dropped when read negative. | NON_NEGATIVE. |
| A1 | validate | Every printed total must equal the rows above it, column by column (to rounding). Rows in a sum that adds up are confirmed. | confirmTotals; the confirming total is listed in the figure’s checks. |
| I1 | validate | Revenue - cost of sales = gross profit. | IDENTITIES; on failure all three are dropped. |
| I2 | validate | Profit before tax - taxation = profit after tax. | IDENTITIES; on failure all three are dropped. |
| B4 | validate | Current + non-current assets = total assets. | IDENTITIES. |
| B5 | validate | Total assets = the printed total equity and liabilities. | applyChecks. |
| F4 | validate | Operating + investing + financing cash flows = net change in cash. | IDENTITIES. |
| F5 | validate | Opening cash + net change (+ exchange differences) = closing cash. | IDENTITIES. |
| X1 | validate | The cash flow’s profit before tax equals the income statement’s for the same period (recorded as a confirmation; a difference is reported, since levies can sit between them). | applyChecks. |
| V5 | validate | A figure read by OCR is delivered only when at least one check (A1, an identity, B5, X1) confirms it. | applyChecks. |
| X2 | notes | The inventory split (raw material, work-in-process, finished goods) is delivered only when the note’s lines add up to its total and that total equals the balance sheet’s stock-in-trade. | reconcile in notes.ts. |
| D1 | derive | A figure that is not printed is calculated only when every input of its formula is available; the formula is delivered with it. Otherwise it is null. | derive.ts. |
| D2 | derive | Average-based ratios need the balance sheet at the start of the period; sub-annual returns and turnovers are annualised (x 12 / months) and say so. | derive.ts. |
| D3 | derive | Price multiples use the PSX closing price on or just before the period end; earnings multiples only 12-month periods. | derive.ts, price.ts. |
