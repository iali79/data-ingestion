/**
 * A small reader for the server-rendered tables on MUFAP's industry pages. Those pages are one flat
 * `<table>` each (no nesting), so a tag scanner is enough and keeps this repository free of an HTML
 * parsing dependency.
 */
export interface HtmlRow {
  cells: string[];
  /** `href` of every anchor inside the row. */
  links: string[];
  /** `onclick` of every anchor inside the row (the monthly AUM page keys funds this way). */
  handlers: string[];
}

const TAG = /<(\/?)(table|tr|td|th|a|br)\b([^>]*)>/gi;

export function readTables(html: string): HtmlRow[][] {
  const tables: HtmlRow[][] = [];
  let table: HtmlRow[] | null = null;
  let row: HtmlRow | null = null;
  let cell: string[] | null = null;
  let last = 0;

  for (const match of html.matchAll(TAG)) {
    if (cell) cell.push(html.slice(last, match.index));
    last = match.index + match[0].length;
    const closing = match[1] === '/';
    const tag = match[2]!.toLowerCase();
    const attrs = match[3] ?? '';

    if (tag === 'table') {
      if (closing) {
        if (table) tables.push(table);
        table = null;
      } else {
        table = [];
      }
    } else if (tag === 'tr') {
      if (closing) {
        if (row && table) table.push(row);
        row = null;
      } else if (table) {
        row = { cells: [], links: [], handlers: [] };
      }
    } else if (tag === 'td' || tag === 'th') {
      if (closing) {
        if (cell && row) row.cells.push(cleanText(cell.join('')));
        cell = null;
      } else if (row) {
        cell = [];
      }
    } else if (tag === 'a' && !closing && row) {
      const href = attribute(attrs, 'href');
      if (href) row.links.push(href);
      const onclick = attribute(attrs, 'onclick');
      if (onclick) row.handlers.push(onclick);
    } else if (tag === 'br' && cell) {
      cell.push(' ');
    }
  }
  return tables;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return match ? decodeEntities(match[2] ?? match[3] ?? '') : null;
}

function cleanText(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}
