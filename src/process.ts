import type { ClaimedTask, ResultPayload } from './contract.js';
import {
  LIMITS,
  envelope,
  selectEvidencePages,
  statementStatus,
  summarizeDocument,
  toActionPayload,
  toLinePayload,
  toInsiderPayload,
  toMeetingPayload,
  toPayoutPayload,
} from './contract.js';
import { isBoardMeetingTitle, parseBoardMeeting } from './meeting.js';
import { isInsiderDisclosureTitle, parseInsiderDisclosure } from './insider.js';
import { isPayoutNoticeTitle, parsePayoutNotice, PAYOUT_OCR } from './payout.js';
import { DocumentExtractionError } from './errors.js';
import { downloadAndExtractDocument, type ExtractedDocument, type OcrPolicy } from './extraction.js';
import type { LlmClient } from './llm/client.js';
import { parseCorporateActionsFromText, parseFinancialStatements } from './parser.js';
import { extractStatements } from './statements/extract.js';
import { statementsIncomplete } from './statements/pages.js';

/** Where a task's document comes from: the document corpus in real runs, a plain download otherwise. */
export interface DocumentSource {
  obtain(sourceUrl: string, meta: { symbol: string }, ocr?: OcrPolicy): Promise<ExtractedDocument>;
}

const DOWNLOAD: DocumentSource = { obtain: (sourceUrl, _meta, ocr) => downloadAndExtractDocument(sourceUrl, ocr) };

/** Readable filings skip OCR entirely; scanned pages are OCR'd only when the statements are not in the text layer. */
export const STATEMENT_OCR: OcrPolicy = { mode: 'if-needed', needsOcr: statementsIncomplete };

/**
 * Turns one claimed task into the result payload the ingest API expects. Never throws. With a
 * model (`llm`), statements are read by it and verified against the page; without one, the
 * rule-based parser is used.
 */
export async function processTask(task: ClaimedTask, documents: DocumentSource = DOWNLOAD, llm: LlmClient | null = null): Promise<ResultPayload> {
  try {
    if (task.kind === 'financial_statement') {
      return llm ? await processStatementWithModel(task, documents, llm) : await processStatement(task, documents);
    }
    return await processNotice(task, documents);
  } catch (error) {
    const known = error instanceof DocumentExtractionError;
    return {
      ...envelope(task),
      outcome: 'failed',
      error: {
        code: known ? error.code : 'extract_failed',
        message: (known ? error.message : 'unexpected extraction error').slice(0, LIMITS.errorMessageChars),
      },
    };
  }
}

async function processStatementWithModel(
  task: Extract<ClaimedTask, { kind: 'financial_statement' }>,
  documents: DocumentSource,
  llm: LlmClient,
): Promise<ResultPayload> {
  const document = await documents.obtain(task.sourceUrl, { symbol: task.context.symbol }, STATEMENT_OCR);
  const extraction = await extractStatements(llm, document, { periodEnded: task.context.periodEnded });
  return statementPayload(task, document, extraction.lines.slice(0, LIMITS.lines).map(toLinePayload), extraction.modelItems);
}

/**
 * The result for a statement task. Evidence is only the pages the figures were read from -- the
 * full text of every filing is kept in the document corpus, not sent to the ingest API.
 */
export function statementPayload(
  task: Extract<ClaimedTask, { kind: 'financial_statement' }>,
  document: ExtractedDocument,
  lines: ReturnType<typeof toLinePayload>[],
  candidateCount: number,
): ResultPayload {
  const cited = new Set(lines.map((line) => line.sourcePage).filter((page): page is number => page !== null));
  return {
    ...envelope(task),
    outcome: 'extracted',
    document: summarizeDocument(document),
    statement: { status: statementStatus(lines, candidateCount, document.kind), candidateCount, lines },
    pages: document.pages
      .filter((page) => cited.has(page.pageNumber))
      .slice(0, LIMITS.pages)
      .map((page) => ({ pageNumber: page.pageNumber, method: page.method, confidence: round4(page.confidence), text: page.text.slice(0, LIMITS.pageTextChars) })),
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function processStatement(
  task: Extract<ClaimedTask, { kind: 'financial_statement' }>,
  documents: DocumentSource,
): Promise<ResultPayload> {
  const document = await documents.obtain(task.sourceUrl, { symbol: task.context.symbol });
  const parsed = parseFinancialStatements(document.text, {
    periodLabel: task.context.periodEnded,
    periodEnd: parsePeriodEnd(task.context.periodEnded),
    pageConfidences: document.pages.map((page) => page.confidence),
  });
  const lines = parsed.promoted.slice(0, LIMITS.lines).map(toLinePayload);
  return {
    ...envelope(task),
    outcome: 'extracted',
    document: summarizeDocument(document),
    statement: {
      status: statementStatus(parsed.promoted, parsed.candidates.length, document.kind),
      candidateCount: parsed.candidates.length,
      lines,
    },
    pages: selectEvidencePages(document, lines),
  };
}

/**
 * A notice's title alone often carries the entitlement ("Final cash dividend 20%"), so a notice
 * with no attachment, or one whose attachment fails to download, is still parsed from its title
 * rather than failed outright.
 *
 * A notice titled as a board meeting is also read for the meeting itself (src/meeting.ts): the
 * date, time and whether it is for results, from the document only -- the title gives none.
 *
 * A notice titled as a disclosure of interest is read for the trades in its table (src/insider.ts).
 *
 * A results or dividend notice is read for the Board's declaration and the book closure
 * (src/payout.ts). Only its covering letter is OCR'd: the statements behind it run to 40 pages
 * and carry nothing the payout needs.
 */
async function processNotice(
  task: Extract<ClaimedTask, { kind: 'corporate_action_notice' }>,
  documents: DocumentSource,
): Promise<ResultPayload> {
  let document: ExtractedDocument | null = null;
  const payoutNotice = isPayoutNoticeTitle(task.context.title);
  if (task.sourceUrl) {
    const obtain = (url: string) =>
      documents.obtain(url, { symbol: task.context.symbol }, payoutNotice ? PAYOUT_OCR : undefined).catch((error: unknown) => {
        if (error instanceof DocumentExtractionError && error.code === 'host_not_allowed') throw error;
        return null;
      });
    // A notice filed as several scanned pages names them all; each is its own image.
    const pages = noticePages(task.sourceUrl, task.context.imageUrls);
    const read: ExtractedDocument[] = [];
    for (const url of pages) {
      const page = await obtain(url);
      if (page) read.push(page);
    }
    document = read.length <= 1 ? (read[0] ?? null) : joinDocuments(read);
  }
  const text = document ? `${task.context.title}\n${document.text}` : task.context.title;
  const candidates = parseCorporateActionsFromText(text, {
    symbol: task.context.symbol,
    announcedAt: new Date(task.context.publishedAt),
  });
  return {
    ...envelope(task),
    outcome: 'extracted',
    document: document ? summarizeDocument(document) : null,
    corporateActions: candidates
      .map(toActionPayload)
      .filter((action) => action !== null)
      .slice(0, LIMITS.actions),
    meeting: document && isBoardMeetingTitle(task.context.title) ? toMeetingPayload(parseBoardMeeting(document.text)) : null,
    // A "Disclosure of Interest" notice carries a table of trades by directors and large holders.
    ...(document && isInsiderDisclosureTitle(task.context.title)
      ? {
          insiderTransactions: parseInsiderDisclosure(document.text, { publishedAt: new Date(task.context.publishedAt), ocr: wasOcrd(document) })
            .slice(0, LIMITS.insiderRows)
            .map(toInsiderPayload),
        }
      : {}),
    ...(document && payoutNotice ? { payout: toPayoutPayload(parsePayoutNotice(leadingText(document), { title: task.context.title })) } : {}),
  };
}

/** The URLs to read for a notice: its image pages when it lists more than one, else its one document. */
export function noticePages(sourceUrl: string, imageUrls: unknown): string[] {
  const pages = Array.isArray(imageUrls) ? imageUrls.filter((url): url is string => typeof url === 'string' && url.length > 0) : [];
  if (pages.length <= 1) return [sourceUrl];
  // The first page is `sourceUrl`; a list that does not start with it is not this notice's.
  return pages[0] === sourceUrl ? pages.slice(0, 12) : [sourceUrl];
}

/** Several one-page documents as one, pages numbered in order. */
export function joinDocuments(parts: ExtractedDocument[]): ExtractedDocument {
  const pages = parts.flatMap((part) => part.pages).map((page, index) => ({ ...page, pageNumber: index + 1 }));
  return {
    kind: parts[0]!.kind,
    method: parts[0]!.method,
    contentType: parts[0]!.contentType,
    text: parts.map((part) => part.text).join('\f'),
    confidence: Math.min(...parts.map((part) => part.confidence)),
    pages,
  };
}

/** Whether any of the text came from OCR, which reads a ruled table's lines as `[`, `|` and `]`. */
function wasOcrd(document: ExtractedDocument): boolean {
  return document.kind === 'image' || document.pages.some((page) => page.method === 'tesseract');
}

/** The pages a payout is read from: the covering letter, as `PAYOUT_OCR` reads it. */
function leadingText(document: ExtractedDocument): string {
  return document.pages.slice(0, PAYOUT_OCR.pages).map((page) => page.text).join('\n');
}

function parsePeriodEnd(value: string): Date | null {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
