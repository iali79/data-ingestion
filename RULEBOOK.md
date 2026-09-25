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
| V1 | normalize | A figure is taken only from a printed table cell. Nothing is typed, estimated or completed; the only correction is R7, a misread the arithmetic proves. | parseFigure: an unreadable cell is null; repair.ts is the only place a reading is replaced. |
| V1b | normalize | A cell holding two figures ("8 45,533,482", "- 1,289": two printed lines fused, or a digit lost from a group) is unreadable. The figures are never glued into one number. | fusedFigures in normalize.ts. |
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
| C9 | normalize | A header naming two lengths ("Year Ended Quarter", two spanning headers merged) gives its column no length; and when any column prints its own length, a column that prints none is not given one from the title or the year-end (a half-year filing’s quarter columns would otherwise read as six months). | describeColumns and periodPhrases in normalize.ts. |
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
| U3 | validate | Income-statement expenses are delivered as positive amounts, except a tax or levy credit, which I2 or I4 shows to be one and which is delivered negative; cash flow figures keep their printed sign. | EXPENSES; applyChecks delivers a credit negative when its identity holds only with the credit sign. |
| U4 | validate | Items that cannot be negative (revenue, total assets, cash, proceeds from selling assets or investments, ...) are dropped when read negative. | NON_NEGATIVE. |
| A1 | validate | Every printed total must equal the rows above it, column by column (to rounding). Rows in a sum that adds up are confirmed. A run of rows found to add up in one column is also checked in every other kept column, so a total with one misread component is caught, not just left unconfirmed. | confirmTotals; A1 constraints in constraints.ts; the confirming total is listed in the figure’s checks. |
| I1 | validate | Revenue - cost of sales = gross profit. | constraints.ts; on failure all three are dropped. |
| I2 | validate | Profit before tax - taxation = profit after tax (a tax credit adds). | constraints.ts; on failure all three are dropped. |
| I3 | validate | Profit attributable to owners + to non-controlling interest = profit after tax. | constraints.ts. |
| I4 | validate | Levies: profit before levies and income tax - levies = profit before income tax (levies above profit before tax), or profit before tax - levies - taxation = profit after tax (levies below it). Only when every row between is a levy line. | constraints.ts. |
| I5 | validate | Gross profit - distribution - administrative - other operating expenses + other income = operating profit, only when those are exactly the rows printed between the two. | constraints.ts. |
| B1 | validate | Total assets = total equity + total liabilities. | constraints.ts. |
| B2 | validate | Current + non-current liabilities = total liabilities. | constraints.ts. |
| B3 | validate | Equity attributable to owners + non-controlling interest = total equity. | constraints.ts. |
| B4 | validate | Current + non-current assets = total assets. | constraints.ts. |
| B5 | validate | Total assets = the printed total equity and liabilities. | constraints.ts. |
| F4 | validate | Operating + investing + financing cash flows = net change in cash. | constraints.ts. |
| F5 | validate | Opening cash + net change (+ exchange differences) = closing cash. | constraints.ts. |
| X1 | validate | The cash flow’s profit before tax equals the income statement’s for the same period (a confirmation when it holds; a difference drops nothing, since levies can sit between them). | constraints.ts, advisory. |
| X3 | validate | A cash flow that starts from profit after tax starts from the income statement’s. | constraints.ts. |
| X4 | validate | The cash flow’s closing cash equals the balance sheet’s cash (or cash less short-term borrowings and overdrafts, whichever the filing uses). | constraints.ts; advisory when neither form holds. |
| X5 | validate | The same item printed in two tables of the same statement, basis and period agrees. | constraints.ts. |
| E1 | validate | Earnings per share: profit attributable to owners over EPS gives the same share count in every column of the statement (to EPS rounding). EPS below 0.10 is too coarse to check. | confirmEps in validate.ts. |
| Adv | validate | An identity is advisory (a failure drops nothing) when the statement prints a line it leaves out: assets held for sale, cash from an amalgamation, an IFRS 9 adjustment, a discontinued operation. | constraints.ts marks it advisory. |
| V6 | validate | A figure is delivered only when at least one relation above confirms it, whether it was read from a text layer or by OCR. A figure no arithmetic touches is not verified and is not delivered. | applyChecks. |
| R7 | verify | A failing relation means a misread cell. Its cells get a second, independent reading (the page’s text layer, or a 300 dpi OCR of a scanned page). A reading is replaced only by a plausible misread of the printed text (one OCR digit confusion, a lost bracket, a dropped or extra digit, a comma read as a point, one figure of two fused) or by the second reading, and only when: every relation containing the cell then holds; two independent relations are closed by it, or one and the second reading agrees; no other correction would do; and nothing that held before breaks. | repair.ts (R7a-R7g); the figure’s checks list "R7 corrected from" the first reading. |
| S1-S9 | derive | Plausibility (gross margin at most 100%, parts within their totals, EPS x shares near profit, ...) is reported for review in the log, never used to drop or repair: minimum tax and bonus issues make real exceptions. | ratioProblems in constraints.ts. |
| X2 | notes | The inventory split (raw material, work-in-process, finished goods) is delivered only when the note’s lines add up to its total and that total equals the balance sheet’s stock-in-trade. | reconcile in notes.ts. |
| D1 | derive | A figure that is not printed is calculated only when every input of its formula is available; the formula is delivered with it. Otherwise it is null. | derive.ts. |
| D2 | derive | Average-based ratios need the balance sheet at the start of the period; sub-annual returns and turnovers are annualised (x 12 / months) and say so. | derive.ts. |
| D3 | derive | Price multiples use the PSX closing price on or just before the period end; earnings multiples only 12-month periods. | derive.ts, price.ts. |
