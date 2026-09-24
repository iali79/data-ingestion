import type { ConsolidationBasis, StatementType } from '../parser.js';
import type { Classification, SelectedStatement } from './classify.js';
import type { StatementTable } from './normalize.js';

/**
 * Hints a reviewer gave for one filing (the task context's `hints`; CONTRACT.md): the unit every
 * statement is printed in, and where a statement is. They replace what the pipeline would have
 * decided on its own for that filing and nothing else; every other rule still runs, and the
 * statement checks still decide what is delivered (rule H1, RULEBOOK.md).
 */
export interface FilingHints {
  unitScale?: 1 | 1000 | 1000000;
  statements?: Array<{ type: StatementType; pages: number[]; basis?: 'consolidated' | 'unconsolidated' }>;
}

const TYPES: readonly string[] = ['income_statement', 'balance_sheet', 'cash_flow'];
const UNITS: readonly unknown[] = [1, 1000, 1000000];

/**
 * The hints if they are well-formed for a document of `pageCount` pages, otherwise none at all:
 * a malformed hint is ignored whole rather than half-applied (rule H0).
 */
export function readHints(raw: unknown, pageCount: number): FilingHints | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'unitScale' && key !== 'statements')) return null;
  const hints: FilingHints = {};
  if (input.unitScale !== undefined) {
    if (!UNITS.includes(input.unitScale)) return null;
    hints.unitScale = input.unitScale as FilingHints['unitScale'];
  }
  if (input.statements !== undefined) {
    if (!Array.isArray(input.statements) || input.statements.length > 6) return null;
    const statements: NonNullable<FilingHints['statements']> = [];
    for (const entry of input.statements as unknown[]) {
      if (typeof entry !== 'object' || entry === null) return null;
      const statement = entry as Record<string, unknown>;
      if (Object.keys(statement).some((key) => !['type', 'pages', 'basis'].includes(key))) return null;
      if (!TYPES.includes(statement.type as string)) return null;
      if (statement.basis !== undefined && statement.basis !== 'consolidated' && statement.basis !== 'unconsolidated') return null;
      const pages = statement.pages;
      if (!Array.isArray(pages) || pages.length === 0 || pages.length > 6) return null;
      if (!pages.every((page, index) => Number.isInteger(page) && page >= 1 && page <= pageCount && (index === 0 || page > pages[index - 1]))) return null;
      statements.push({ type: statement.type as StatementType, pages: [...(pages as number[])], ...(statement.basis ? { basis: statement.basis as 'consolidated' | 'unconsolidated' } : {}) });
    }
    if (statements.length > 0) hints.statements = statements;
  }
  return hints.unitScale === undefined && !hints.statements ? null : hints;
}

/**
 * Rule H2: a hinted statement replaces the classifier's choice for its type -- for its basis when
 * the hint names one (and statements whose basis the classifier could not tell), otherwise for
 * every basis. The hinted pages are selected, and say so in their reasons.
 */
export function applyPageHints(classification: Classification, hints: FilingHints | null): Classification {
  if (!hints?.statements?.length) return classification;
  let statements = [...classification.statements];
  const pages = classification.pages.map((page) => ({ ...page, reasons: [...page.reasons] }));
  for (const hint of hints.statements) {
    statements = statements.filter(
      (statement) => statement.statementType !== hint.type || (hint.basis !== undefined && statement.basis !== hint.basis && statement.basis !== 'unknown'),
    );
    const first = pages.find((page) => page.pageNumber === hint.pages[0]);
    const basis: ConsolidationBasis = hint.basis ?? first?.basis ?? 'unknown';
    const hinted: SelectedStatement = { statementType: hint.type, basis, pages: [...hint.pages], hinted: true };
    statements.push(hinted);
    for (const page of pages) {
      if (!hint.pages.includes(page.pageNumber)) continue;
      page.class = hint.type;
      page.basis = basis;
      page.selected = true;
      page.reasons.push(`admin hint: ${hint.type.replace('_', ' ')}`);
    }
  }
  const selectedPages = [...new Set([...statements.flatMap((item) => item.pages), ...classification.notes.flatMap((item) => item.pages)])].sort((a, b) => a - b);
  return { ...classification, pages, statements, selectedPages };
}

/** Rule H3: every statement is in the hinted unit, whatever it printed or inherited. */
export function applyUnitHint(tables: StatementTable[], hints: FilingHints | null): void {
  if (!hints?.unitScale) return;
  for (const table of tables) {
    if (table.unitScale === hints.unitScale && table.unitPrinted) continue;
    table.problems.push(`unit x${hints.unitScale} from an admin hint (read ${table.unitPrinted ? `x${table.unitScale} as printed` : 'no printed unit'})`);
    table.unitScale = hints.unitScale;
  }
}
