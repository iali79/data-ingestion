import type { ConsolidationBasis, StatementType } from '../parser.js';
import {
  MIN_FIGURE_LINES,
  OTHER_TITLE,
  SUMMARY_PAGE,
  TITLES,
  TITLE_PREFIX,
  basisFrom,
  figureLines,
  headingSegments,
  sideBySideColumns,
  titleOffsets,
} from '../statements/pages.js';
import type { DocumentAnalysis, PageAnalysis } from './analyse.js';

/**
 * Stage 2 -- page classifier. Decides, for every page, what it is, and keeps only the pages the
 * later stages need: the three primary statements per consolidation basis, and the few notes
 * that carry items the statements do not (share count, inventory split, fixed assets,
 * dividends). Everything else -- chairman's review, graphs, "six years at a glance", auditors'
 * report, the remaining notes -- is dropped here and never reaches table extraction.
 *
 * Selection is positive: a page is kept only when it is recognised. A chart page is never
 * "detected and removed"; it simply never scores as a statement. Every decision records its
 * reasons, so a wrong selection can be explained from `classification.json` alone.
 */
export type PageClass =
  | 'balance_sheet'
  | 'income_statement'
  | 'comprehensive_income'
  | 'cash_flow'
  | 'equity_changes'
  | 'note'
  | 'ignore';

export type NoteTopic = 'share_capital' | 'stock_in_trade' | 'fixed_assets' | 'dividends';

export interface PageDecision {
  pageNumber: number;
  class: PageClass;
  basis: ConsolidationBasis;
  topic?: NoteTopic;
  selected: boolean;
  reasons: string[];
}

export interface SelectedStatement {
  statementType: StatementType;
  basis: ConsolidationBasis;
  /** One page, or more when the statement continues onto the next page. */
  pages: number[];
  /** Character columns of this statement when printed beside another (layout text). */
  columns?: [number, number];
}

export interface SelectedNote {
  topic: NoteTopic;
  basis: ConsolidationBasis;
  pages: number[];
  /** The note number printed in its heading ("16 ISSUED, SUBSCRIBED AND PAID-UP CAPITAL"). */
  number: string;
}

export interface Classification {
  pages: PageDecision[];
  statements: SelectedStatement[];
  notes: SelectedNote[];
  /** Every page any later stage reads, ascending. */
  selectedPages: number[];
}

/**
 * Captions that only appear on one kind of statement. A title alone can sit on a page with no
 * table (a divider, a contents list); a statement page also prints its own captions.
 */
const ANCHORS: Record<StatementType, RegExp[]> = {
  balance_sheet: [/\btotal\s+assets\b/iu, /\bshare\s+capital\b/iu, /\bcurrent\s+liabilities\b/iu, /\bnon[-\s]?current\s+assets\b/iu, /\bequity\s+and\s+liabilities\b/iu, /\btrade\s+debts\b/iu, /\bcash\s+and\s+bank\b/iu],
  income_statement: [/\bgross\s+(?:profit|loss)\b/iu, /\b(?:profit|loss)\s+before\s+tax/iu, /\b(?:earnings|loss)\s+per\s+share\b/iu, /\bcost\s+of\s+(?:sales|revenue|goods)\b/iu, /\b(?:net\s+)?(?:sales|revenue)\b/iu, /\btaxation\b/iu],
  cash_flow: [/\bnet\s+cash\b/iu, /\boperating\s+activities\b/iu, /\binvesting\s+activities\b/iu, /\bfinancing\s+activities\b/iu, /\bcash\s+and\s+cash\s+equivalents\b/iu, /\bcash\s+generated\s+from\s+operations\b/iu],
};

/** Captions a statement's last page prints; without them the statement continues overleaf. */
const CLOSING: Record<StatementType, RegExp> = {
  balance_sheet: /\bequity\s+and\s+liabilities\b|\btotal\s+liabilities\b/iu,
  income_statement: /\b(?:earnings|loss)\s+per\s+share\b|\b(?:profit|loss)\s+(?:after\s+tax(?:ation)?|for\s+the\s+(?:year|period))\b/iu,
  cash_flow: /\bcash\s+and\s+cash\s+equivalents\s+at\s+(?:the\s+)?end\b|\bend\s+of\s+the\s+(?:year|period)\b/iu,
};

const OTHER_TITLES: Array<[PageClass, RegExp]> = [
  ['comprehensive_income', /^statement\s+of\s+(?:other\s+)?comprehensive\s+income\b/iu],
  ['equity_changes', /^statement\s+of\s+changes\s+in\s+(?:shareholders['’]?\s+)?equity\b/iu],
];

/** How each note's heading, and the balance sheet caption that refers to it, read. */
const NOTE_TOPICS: Array<[NoteTopic, RegExp]> = [
  ['share_capital', /(?:issued,?\s+subscribed\s+and\s+paid[-\s]?up\s+(?:share\s+)?capital|share\s+capital)\b/iu],
  ['stock_in_trade', /(?:stock[-\s]in[-\s]trade|inventor(?:y|ies))\b/iu],
  ['fixed_assets', /(?:property,?\s+plant\s+and\s+equipment|operating\s+(?:fixed\s+)?assets|fixed\s+assets)\b/iu],
  ['dividends', /(?:events?\s+(?:after|subsequent\s+to)\s+(?:the\s+)?(?:reporting\s+(?:period|date)|balance\s+sheet\s+date|statement\s+of\s+financial\s+position\s+date|year[-\s]end)|non[-\s]adjusting\s+events?|subsequent\s+events?|dividends?(?:\s+and\s+appropriations)?)\b/iu],
];

/** What may follow a statement title on its line. */
const TITLE_TAIL = /^(?:\s*$|\s*(?:and\s+other\s+comprehensive\s+income|account|\(|for\s+the\b|as\s+(?:at|on)\b|[-–—:]|\d))/iu;

/** A year header ("2025 2024"), as the top of a scanned statement shows it. */
const YEAR_HEADER = /\b(?:19|20)\d{2}\b[^\n]{0,40}\b(?:19|20)\d{2}\b/u;

/** A basis banner: "Consolidated Financial Statements" printed as a divider or running title. */
const BASIS_BANNER = /^(un-?consolidated|separate|consolidated)\s+(?:condensed\s+)?(?:interim\s+)?financial\s+statements\b/iu;

/** A company name before the title on the same line, as OCR reads a letterhead: "ADAM SUGAR MILLS LIMITED STATEMENT OF ...". */
const COMPANY_SUFFIX = /\b(?:limited|ltd)\b\.?\)?\s*/giu;

export function classifyPages(analysis: DocumentAnalysis): Classification {
  const decisions: PageDecision[] = [];
  const statements: SelectedStatement[] = [];
  let bannerBasis: ConsolidationBasis = 'unknown';

  for (const [index, page] of analysis.pages.entries()) {
    const decision: PageDecision = { pageNumber: page.pageNumber, class: 'ignore', basis: bannerBasis, selected: false, reasons: [] };
    decisions.push(decision);
    if (page.kind === 'blank') {
      decision.reasons.push('blank page');
      continue;
    }
    const segments = headingSegments(page.text);
    const banner = segments.map((segment) => BASIS_BANNER.exec(stripCompany(segment))).find(Boolean);
    if (banner) {
      bannerBasis = basisFrom(banner[1]);
      decision.basis = bannerBasis;
    }
    if (SUMMARY_PAGE.test(segments.join('\n'))) {
      decision.reasons.push('summary or analysis page (highlights, years at a glance, horizontal/vertical analysis)');
      continue;
    }

    const titles = titlesIn(segments);
    const other = segments.map((segment) => OTHER_TITLES.find(([, title]) => title.test(stripPrefix(stripCompany(segment))))?.[0]).find(Boolean);
    if (titles.length === 0) {
      if (other) {
        decision.class = other;
        decision.reasons.push(`title: ${other.replace('_', ' ')} (not extracted)`);
      } else decision.reasons.push('no statement title in the heading');
      continue;
    }

    const figures = figureLines(page.text);
    const offsets = page.kind === 'native' ? titleOffsets(page.text) : [];
    for (const { type, basis: titleBasis, text } of titles) {
      const basis = titleBasis ?? bannerBasis;
      const anchors = ANCHORS[type].filter((anchor) => anchor.test(page.text)).length;
      const reasons = [`title "${text.slice(0, 80)}"`, `${anchors} anchor caption(s)`, `${figures} figure line(s)`, page.kind];
      // A native statement page is a table of its own captions; a scanned page's title strip holds
      // only the top of the page, so its table is confirmed at extraction instead.
      if (page.kind === 'native' && (figures < MIN_FIGURE_LINES || anchors === 0)) {
        decision.reasons.push(`${reasons.join(', ')}: title without a statement table`);
        continue;
      }
      if (page.kind === 'scanned' && anchors === 0 && figures < 2 && !YEAR_HEADER.test(page.text)) {
        decision.reasons.push(`${reasons.join(', ')}: title strip shows no figures, year header or statement caption`);
        continue;
      }
      // The same statement found twice for one basis: the first is the statement itself (the
      // statements precede the notes, which may repeat a title as a sub-heading).
      if (statements.some((item) => item.statementType === type && item.basis === basis)) {
        decision.reasons.push(`${reasons.join(', ')}: repeat of an earlier ${type.replace('_', ' ')} (${basis})`);
        continue;
      }
      const columns = titles.length > 1 ? sideBySideColumns(offsets, type) : undefined;
      const pages = [page.pageNumber];
      const next = analysis.pages[index + 1];
      if (titles.length === 1 && next && continuesOnto(type, page, next)) {
        pages.push(next.pageNumber);
        reasons.push(`continues on p.${next.pageNumber}`);
      }
      statements.push({ statementType: type, basis, pages, ...(columns ? { columns } : {}) });
      decision.class = type;
      decision.basis = basis;
      decision.selected = true;
      decision.reasons.push(reasons.join(', '));
    }
  }

  for (const statement of statements) {
    for (const pageNumber of statement.pages.slice(1)) {
      const decision = decisions[pageNumber - 1]!;
      if (decision.selected) continue;
      Object.assign(decision, { class: statement.statementType, basis: statement.basis, selected: true });
      decision.reasons.push(`continuation of the ${statement.statementType.replace('_', ' ')} on p.${statement.pages[0]}`);
    }
  }

  const notes = findNotes(analysis, statements, decisions);
  const selectedPages = [...new Set([...statements.flatMap((item) => item.pages), ...notes.flatMap((item) => item.pages)])].sort((a, b) => a - b);
  return { pages: decisions, statements, notes, selectedPages };
}

/**
 * The statement goes on overleaf when this page lacks its closing captions and the next page
 * carries a table with no title of its own.
 */
function continuesOnto(type: StatementType, page: PageAnalysis, next: PageAnalysis): boolean {
  if (next.kind === 'blank' || titlesIn(headingSegments(next.text)).length > 0) return false;
  if (OTHER_TITLE.test(headingSegments(next.text).join(' '))) return false;
  if (page.kind === 'native') {
    return !CLOSING[type].test(page.text) && figureLines(next.text) >= MIN_FIGURE_LINES && ANCHORS[type].some((anchor) => anchor.test(next.text));
  }
  // Scanned: only the title strips are read so far. The next page continues the statement when
  // its strip already shows figures (a table from the top) and closing captions.
  return next.kind === 'scanned' && figureLines(next.text) >= 3 && CLOSING[type].test(next.text);
}

/**
 * Notes are found by the number the balance sheet prints beside a caption ("Stock-in-trade 12"
 * leads to the page whose line starts "12 STOCK-IN-TRADE"). Without a printed reference (a
 * scanned balance sheet, or the dividends note, which no caption cites) the first whole-numbered
 * heading on the topic is taken: "2.3 Property, plant and equipment" is an accounting policy, not
 * the note. One note per topic and basis, searched after that basis's statements. The fixed
 * assets note takes the next page too: its schedule of cost and depreciation usually runs over two.
 */
function findNotes(analysis: DocumentAnalysis, statements: SelectedStatement[], decisions: PageDecision[]): SelectedNote[] {
  const notes: SelectedNote[] = [];
  const sections = statements
    .map((statement) => ({ basis: statement.basis, last: Math.max(...statement.pages) }))
    .sort((a, b) => a.last - b.last);
  if (sections.length === 0) return notes;
  const references = new Map<string, string>();
  for (const statement of statements) {
    if (statement.statementType !== 'balance_sheet') continue;
    for (const pageNumber of statement.pages) {
      for (const [topic, number] of noteReferences(analysis.pages[pageNumber - 1]!.text)) {
        if (!references.has(`${topic}|${statement.basis}`)) references.set(`${topic}|${statement.basis}`, number);
      }
    }
  }
  for (const page of analysis.pages) {
    const decision = decisions[page.pageNumber - 1]!;
    // Statement pages carry no notes; a page kept for one note may start another.
    if ((decision.selected && decision.class !== 'note') || page.kind === 'blank') continue;
    const section = sections.filter((item) => item.last < page.pageNumber).at(-1);
    if (!section) continue;
    for (const [topic, words] of NOTE_TOPICS) {
      if (notes.some((note) => note.topic === topic && note.basis === section.basis)) continue;
      const cited = references.get(`${topic}|${section.basis}`);
      const number = noteHeading(page.text, words, cited);
      if (!number) continue;
      if (topic === 'dividends' && !/\bdividend/iu.test(page.text)) continue;
      const pages = [page.pageNumber];
      if (topic === 'fixed_assets' && page.pageNumber < analysis.pageCount) pages.push(page.pageNumber + 1);
      notes.push({ topic, basis: section.basis, pages, number });
      for (const pageNumber of pages) {
        const target = decisions[pageNumber - 1]!;
        if (target.selected) continue;
        Object.assign(target, { class: 'note' as const, topic, basis: section.basis, selected: true });
        target.reasons.push(`note ${number} heading: ${topic.replace(/_/gu, ' ')}${cited ? ' (cited by the balance sheet)' : ''}`);
      }
    }
  }
  return notes;
}

/**
 * Note numbers printed beside balance sheet captions: "Stock-in-trade   12   4,312,764",
 * "Stock-in-trade - net  10  6,617,315", or as OCR reads a scan, "Stock in trade 9 4,244,944,640".
 */
function noteReferences(text: string): Array<[NoteTopic, string]> {
  const found: Array<[NoteTopic, string]> = [];
  for (const line of text.split('\n')) {
    for (const [topic, words] of NOTE_TOPICS) {
      if (topic === 'dividends' || found.some(([seen]) => seen === topic)) continue;
      const caption = words.exec(line);
      if (!caption) continue;
      // Caption, any qualifier ("- net", "- considered good"), the note number, then a figure.
      const reference = /^[^\d\n]{0,80}?\s(\d{1,2}(?:\.\d{1,2})?)\s+(?:\(?\d{1,3}(?:[,.]\d{3})+|-\s)/u.exec(line.slice(caption.index + caption[0].length));
      if (reference) found.push([topic, reference[1]!]);
    }
  }
  return found;
}

/**
 * The note number when a heading on the topic starts a line, or a layout column of a two-column
 * page ("...investment properties or for      10   STOCK-IN-TRADE - net"): the cited number, or
 * any whole number when nothing cites the note.
 */
function noteHeading(text: string, words: RegExp, cited: string | undefined): string | null {
  const start = /(?:^\s*|\s{3,})(\d{1,2}(?:\.\d{1,2})?)\.?\s{1,12}(?=\S)/gu;
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(start)) {
      const number = match[1]!;
      const rest = line.slice(match.index + match[0].length);
      const topic = words.exec(rest.slice(0, 80));
      const topical = topic !== null && topic.index < 5;
      if (cited ? number === cited && (topical || /^[A-Z][A-Z ,&'’()-]{6,}/u.test(rest)) : topical && /^\d{1,2}$/u.test(number)) return number;
    }
  }
  return null;
}

function titlesIn(segments: string[]): Array<{ type: StatementType; basis: ConsolidationBasis | null; text: string }> {
  const titles: Array<{ type: StatementType; basis: ConsolidationBasis | null; text: string }> = [];
  for (const segment of segments) {
    for (const candidate of [segment, ...afterCompany(segment)]) {
      const prefix = TITLE_PREFIX.exec(candidate)?.[0] ?? '';
      const rest = candidate.slice(prefix.length);
      const match = TITLES.map(([type, title]) => ({ type, found: title.exec(rest) })).find((item) => item.found);
      const type = match?.type;
      if (!type || titles.some((title) => title.type === type)) continue;
      // A title stands alone on its line or runs into its period ("... as at June 30, 2025");
      // "statement of profit or loss, ..." is the auditor's report listing the statements.
      if (!TITLE_TAIL.test(rest.slice(match.found![0].length))) continue;
      // "Statement of Comprehensive Income" alone restates profit for the year; skip it.
      if (type === 'income_statement' && /comprehensive/iu.test(rest) && !/profit/iu.test(rest)) continue;
      const word = /\b(un-?consolidated|separate|standalone|consolidated)\b/iu.exec(prefix)?.[1];
      titles.push({ type, basis: word ? basisFrom(word) : null, text: candidate });
      break;
    }
  }
  return titles;
}

/** The text after each "LIMITED" / "LTD" in a heading line. */
function afterCompany(segment: string): string[] {
  return [...segment.matchAll(COMPANY_SUFFIX)].map((match) => segment.slice(match.index + match[0].length)).filter((rest) => rest.length > 0);
}

function stripCompany(segment: string): string {
  return afterCompany(segment).at(-1) ?? segment;
}

function stripPrefix(segment: string): string {
  return segment.slice((TITLE_PREFIX.exec(segment)?.[0] ?? '').length);
}
