import type { PeriodFigures } from './financials/derive.js';

/**
 * Scoring delivered periods against a hand-checked answer key. Shared by the live dry run
 * (`evaluate.ts`) and the offline replay (`replay.ts`), so both count a figure as correct, wrong
 * or missing by the same rule.
 *
 * An answer key is keyed by source URL, then `statement|period end|months` (months 0 = balance
 * sheet date), and `|basis` in a key exported from the review panel, where both bases may be read.
 */
export type AnswerKey = Record<string, Record<string, Record<string, number>>>;

export interface Score {
  expected: number;
  correct: number;
  wrong: string[];
  missing: string[];
}

const SECTION = { income: 'income', balance: 'balance', cash_flow: 'cashFlow' } as const;

export function scorePeriods(periods: PeriodFigures[], key: Record<string, Record<string, number>>): Score {
  const score: Score = { expected: 0, correct: 0, wrong: [], missing: [] };
  for (const [label, items] of Object.entries(key)) {
    // `statement|period end|months`, and `|basis` in an exported key (where both bases may be read).
    const [statement, end, monthsText, basis] = label.split('|') as [keyof typeof SECTION, string, string, string | undefined];
    const months = Number(monthsText);
    for (const [item, expected] of Object.entries(items)) {
      score.expected += 1;
      const found = periods
        .filter((period) => period.periodEnd === end && (months === 0 ? true : period.months === months) && (!basis || period.basis === basis))
        .map((period) => period[SECTION[statement]][item])
        .find((figure) => figure);
      if (!found) score.missing.push(`${label} ${item} (expected ${format(expected)})`);
      else if (Math.abs(found.value - expected) <= Math.max(Math.abs(expected) * 1e-9, 0.005)) score.correct += 1;
      else score.wrong.push(`${label} ${item}: expected ${format(expected)}, got ${format(found.value)} (${found.source}${found.formula ? `: ${found.formula}` : ''})`);
    }
  }
  return score;
}

export function countFigures(periods: PeriodFigures[]): { reported: number; derived: number; empty: number } {
  const counts = { reported: 0, derived: 0, empty: 0 };
  for (const period of periods) {
    for (const section of [period.income, period.balance, period.cashFlow, period.ratios]) {
      for (const figure of Object.values(section)) {
        if (!figure) counts.empty += 1;
        else if (figure.source === 'reported') counts.reported += 1;
        else counts.derived += 1;
      }
    }
  }
  return counts;
}

export function format(value: number): string {
  return Math.abs(value) < 1_000 ? String(value) : value.toLocaleString('en-US');
}
