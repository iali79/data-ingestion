import type { ExtractedDocument } from '../extraction.js';
import type { LlmClient } from '../llm/client.js';
import { addDerivedLines, dedupeBest, type ParsedStatementLine } from '../parser.js';
import { readStatement } from './llm-extract.js';
import { findStatementPages, type StatementPage } from './pages.js';
import { verifyReading, type VerifiedStatement } from './verify.js';

/**
 * The statement pipeline for one filing: locate the statement pages, have the model read each,
 * verify every reading against its page, then add the derived lines (margins, EBITDA, ...) the
 * ingest contract carries. Returns the lines plus a trace of what was read, dropped and why.
 */
export interface StatementTrace {
  statementType: string;
  basis: string;
  pages: number[];
  found: boolean;
  columns: VerifiedStatement['columns'];
  unitScale: number;
  items: number;
  kept: number;
  dropped: VerifiedStatement['dropped'];
  promptTokens: number;
  completionTokens: number;
  ms: number;
  error?: string;
}

export interface FilingExtraction {
  lines: ParsedStatementLine[];
  statements: StatementTrace[];
  /** Pages the lines came from: the only page text sent as evidence. */
  evidencePages: number[];
  modelItems: number;
}

export async function extractStatements(
  llm: LlmClient,
  document: ExtractedDocument,
  filing: { periodEnded: string },
): Promise<FilingExtraction> {
  const statements = findStatementPages(document);
  const traces: StatementTrace[] = [];
  const lines: ParsedStatementLine[] = [];
  let modelItems = 0;

  for (const statement of statements) {
    const base = baseTrace(statement);
    try {
      const { reading, promptTokens, completionTokens, ms } = await readStatement(llm, statement);
      modelItems += reading.items.length;
      if (!reading.found) {
        traces.push({ ...base, found: false, promptTokens, completionTokens, ms });
        continue;
      }
      const verified = verifyReading(statement, reading, filing);
      lines.push(...verified.lines);
      traces.push({
        ...base,
        found: true,
        columns: verified.columns,
        unitScale: verified.unitScale,
        items: reading.items.length,
        kept: verified.lines.length,
        dropped: verified.dropped,
        promptTokens,
        completionTokens,
        ms,
      });
    } catch (error) {
      traces.push({ ...base, error: error instanceof Error ? error.message.slice(0, 200) : 'model call failed' });
    }
  }

  const merged = dedupeBest(lines);
  addDerivedLines(merged);
  const evidencePages = [...new Set(merged.map((line) => line.sourcePage).filter((page): page is number => page !== null))].sort((a, b) => a - b);
  return { lines: merged, statements: traces, evidencePages, modelItems };
}

function baseTrace(statement: StatementPage): StatementTrace {
  return {
    statementType: statement.statementType,
    basis: statement.basis,
    pages: statement.pages.map((page) => page.pageNumber),
    found: false,
    columns: [],
    unitScale: 1,
    items: 0,
    kept: 0,
    dropped: [],
    promptTokens: 0,
    completionTokens: 0,
    ms: 0,
  };
}
