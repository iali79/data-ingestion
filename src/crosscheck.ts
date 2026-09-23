import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Compares filings with each other. A company prints most periods twice: as the current period
 * of one filing and as the comparative column of the next. Every reported figure for the same
 * company, basis, item and period should therefore agree across filings. Where they do not, one
 * of three things happened, and a person has to say which:
 *
 * - a restatement (the later filing marks the column "Restated"; a reclassification such as the
 *   2024 minimum-tax levy moves profit before tax and taxation by the same amount);
 * - a misprint in the filing itself (a comparative figure printed on the wrong line);
 * - a reading error: a row shift the table arithmetic cannot see, since the section still adds up.
 *
 * This is a report, never a filter: nothing is dropped here. It needs no answer key, so it covers
 * every filing in the sample.
 *
 *   node dist/crosscheck.js <dir with the evaluation's <symbol>-<id>.json payloads>
 */
interface Figure {
  value: number | null;
  source: string;
  page?: number;
  text?: string;
}

interface Payload {
  schemaVersion: number;
  filing: { symbol: string; url: string; periodEnded: string };
  periods: Array<{ periodEnd: string; months: number; basis: string } & Record<string, unknown>>;
}

const SECTIONS = ['income', 'balance', 'cashFlow'] as const;

async function payloads(dir: string): Promise<Payload[]> {
  const found: Payload[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(entry.parentPath, entry.name);
    try {
      const json = JSON.parse(await readFile(file, 'utf8')) as Payload;
      if (json.schemaVersion === 2 && Array.isArray(json.periods) && json.filing?.symbol) found.push(json);
    } catch {
      // Stage files and anything else that is not a payload.
    }
  }
  return found;
}

export function compare(filings: Payload[]): { compared: number; disagreements: string[] } {
  const seen = new Map<string, Array<{ id: string; value: number; text: string }>>();
  for (const filing of filings) {
    const id = /[?&]id=(\d+)/u.exec(filing.filing.url)?.[1] ?? filing.filing.url;
    for (const period of filing.periods) {
      for (const section of SECTIONS) {
        const items = period[section] as Record<string, Figure> | undefined;
        for (const [item, figure] of Object.entries(items ?? {})) {
          if (figure?.source !== 'reported' || figure.value === null) continue;
          const key = [filing.filing.symbol, period.basis, section, item, period.periodEnd, period.months].join(' ');
          seen.set(key, [...(seen.get(key) ?? []), { id, value: figure.value, text: `p.${figure.page ?? '?'} ${figure.text ?? ''}` }]);
        }
      }
    }
  }
  let compared = 0;
  const disagreements: string[] = [];
  for (const [key, readings] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
    if (new Set(readings.map((reading) => reading.id)).size < 2) continue;
    compared++;
    if (new Set(readings.map((reading) => reading.value)).size === 1) continue;
    disagreements.push(`| ${key.replace(/ /gu, ' | ')} | ${readings.map((reading) => `${reading.id}: ${reading.value.toLocaleString('en-US')} (${reading.text.replace(/\|/gu, '/').slice(0, 90)})`).join('<br>')} |`);
  }
  return { compared, disagreements };
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: crosscheck <dir>');
  const { compared, disagreements } = compare(await payloads(dir));
  const lines = [
    '## Same figure, several filings',
    '',
    `${compared} reported figures are printed in two or more filings; **${disagreements.length}** differ between them. Each difference is a restatement, a misprint in a filing, or a reading error, and needs a look. Nothing is dropped because of this report.`,
    '',
  ];
  if (disagreements.length) lines.push('| Symbol | Basis | Statement | Item | Period end | Months | Filings |', '|---|---|---|---|---|---|---|', ...disagreements, '');
  process.stdout.write(`${lines.join('\n')}\n`);
}

// Run as a script; imported (by the tests) it only exports compare().
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
