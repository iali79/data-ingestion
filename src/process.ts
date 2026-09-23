import type { ClaimedTask, ResultPayload } from './contract.js';
import {
  LIMITS,
  envelope,
  selectEvidencePages,
  statementStatus,
  summarizeDocument,
  toActionPayload,
  toLinePayload,
} from './contract.js';
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
 */
async function processNotice(
  task: Extract<ClaimedTask, { kind: 'corporate_action_notice' }>,
  documents: DocumentSource,
): Promise<ResultPayload> {
  let document: ExtractedDocument | null = null;
  if (task.sourceUrl) {
    document = await documents.obtain(task.sourceUrl, { symbol: task.context.symbol }).catch((error: unknown) => {
      if (error instanceof DocumentExtractionError && error.code === 'host_not_allowed') throw error;
      return null;
    });
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
  };
}

function parsePeriodEnd(value: string): Date | null {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
