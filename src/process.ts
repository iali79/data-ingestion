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
import { downloadAndExtractDocument, type ExtractedDocument } from './extraction.js';
import { parseCorporateActionsFromText, parseFinancialStatements } from './parser.js';

/** Where a task's document comes from: the document corpus in real runs, a plain download otherwise. */
export interface DocumentSource {
  obtain(sourceUrl: string, meta: { symbol: string }): Promise<ExtractedDocument>;
}

const DOWNLOAD: DocumentSource = { obtain: (sourceUrl) => downloadAndExtractDocument(sourceUrl) };

/** Turns one claimed task into the result payload the ingest API expects. Never throws. */
export async function processTask(task: ClaimedTask, documents: DocumentSource = DOWNLOAD): Promise<ResultPayload> {
  try {
    return task.kind === 'financial_statement' ? await processStatement(task, documents) : await processNotice(task, documents);
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
