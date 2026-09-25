import { parseFigure, type StatementRow } from './normalize.js';
import { joinBrackets, pieces, sameWord, tokens, words, type Token } from './reread.js';

/**
 * Rule R4c: rows the table model fused or shifted, rebuilt from the page's text layer.
 *
 * Docling can read two or three printed lines as one table row ("Minimum tax differential paid
 * Final tax paid" | "(177,076) (19,904)" | "(212,781) (2,904)"), and a column's figures can then
 * sit one row off their captions for a few rows below. Such a cell is unreadable (parseFigure
 * never glues two figures into one), so every sum through it is unchecked and rule V6 withholds
 * the section. On a native page `pdftotext -layout` prints each line on its own line of text, with
 * each figure right-aligned under its column, so the printed lines can be read back:
 *
 * 1. Columns. A clean row (one figure per cell, at least one of them with a thousands separator
 *    or four digits) whose figures appear as one consecutive run of tokens on exactly one line of
 *    the page fixes where its columns end on that line. Each value column's position is the
 *    median over such rows; at least two rows must place every column, most of them within two
 *    characters of the median, and the columns must be in order. Otherwise the piece is left
 *    alone. The caption band is fixed the same way, from where those rows' captions start.
 * 2. Lines. Every line's figures are placed in the column whose position is nearest their right
 *    edge (a dash by its centre), within under half the narrowest gap between columns. A line
 *    with a figure inside the columns' span that fits no column, or two figures in one column, is
 *    unclear and never used.
 * 3. Alignment. Rows are paired with lines, in order, where the row's cells equal the line's
 *    figures column by column, as printed (a row of dashes or small figures only where its
 *    caption agrees too). A pairing whose caption disagrees with the line's (fewer than two
 *    thirds of its words there, counting a caption wrapped over the lines just above) is dropped:
 *    the table model filed the next or previous line's caption with those figures. The rows
 *    between two pairings, before the first or after the last, form a block. A block is rebuilt
 *    only when it holds a fused cell (two or more figures) or a row whose pairing was dropped,
 *    and only when all of the following hold:
 *    - the block's figures, read down each column, are exactly the figures of a run of
 *      consecutive lines, read down the same column (for a block between two pairings, every
 *      line between them; before the first or after the last, the lines up to where the figures
 *      run out), and none of those lines is unclear. A note reference the table model read into
 *      a value cell ("13.3 (18,055)") is set aside when the line prints it as its note. A row
 *      with anything but figures in a cell (a unit read into a value column) ends a block: the
 *      rows above it are read down from the pairing above, those below it up from the pairing
 *      below;
 *    - the block's captions and headings, word by word, are exactly the captions of those lines
 *      and of the caption-only lines between them (and, for the block's first headings, just
 *      above them). Failing that, the same words in another order (the table model can file a
 *      caption's last words as a heading) with at most MAX_EXTRA words it lost, or one line
 *      whose whole caption it lost; every word it read must still be on the lines. A caption-only
 *      line whose words were the block's headings stays a heading; one whose words were part of
 *      a caption is the start of the next line's caption (or, when it begins in lower case, the
 *      end of the previous one's).
 *    Where the captions do not close within the block (the table model's caption boundaries
 *    can differ from its figure boundaries), the block takes in up to MAX_ABSORB pairings on
 *    either side, fewest first, exact captions at every size before the looser match.
 *    Then the block becomes one row per line, with the line's caption and its figures per
 *    column. Nothing is guessed: every figure of the rebuilt rows is a figure the table model
 *    read, now on the line the page prints it on, and each caption is the one printed on that
 *    line. When anything does not match, the block is left as it was and its fused cells stay
 *    unreadable. The rebuilt figures still have to pass every check of stage 6 (V6).
 *
 * Row ids stay stable: a block rebuilt into as many rows with the same captions (a shift) keeps
 * its ids; otherwise the new rows are named after the block's first row, "p13.r34a", "p13.r34b",
 * ..., which reread.ts still reads as row 34 of its piece.
 */
export interface TextRebuild {
  rows: StatementRow[];
  /** The rows rebuilt from the text layer: printed lines, which rule R4 must not merge again. */
  rebuilt: Set<StatementRow>;
  /** One line per page where blocks were rebuilt, for the statement's problems. */
  problems: string[];
}

export function rebuildFromText(rows: StatementRow[], layoutText: (page: number) => string | null): TextRebuild {
  const out: StatementRow[] = [];
  const rebuilt = new Set<StatementRow>();
  const problems: string[] = [];
  for (let start = 0; start < rows.length; ) {
    const page = rows[start]!.page;
    let end = start;
    while (end < rows.length && rows[end]!.page === page) end++;
    const onPage = rows.slice(start, end);
    start = end;
    const text = layoutText(page);
    if (!text || !onPage.some(isFused)) {
      out.push(...onPage);
      continue;
    }
    const lines = text.split(/\r?\n/u).map((line) => joinBrackets(tokens(line)));
    let blocks = 0;
    let made = 0;
    for (const piece of pieces(onPage)) {
      const result = rebuildPiece(piece, lines);
      out.push(...result.rows);
      for (const row of result.rebuilt) rebuilt.add(row);
      blocks += result.blocks;
      made += result.rebuilt.length;
    }
    if (blocks > 0) problems.push(`p.${page}: ${blocks} block(s) of fused or shifted rows re-read from the text layer as ${made} rows (R4c)`);
  }
  // Ids must stay unique within the statement; if a rebuilt id collides, nothing is rebuilt.
  const seen = new Set<string>();
  for (const row of out) {
    if (seen.has(row.id)) return { rows, rebuilt: new Set(), problems: [] };
    seen.add(row.id);
  }
  return { rows: out, rebuilt, problems };
}

/** A row with a cell holding two or more figures: printed lines read as one. */
export function isFused(row: StatementRow): boolean {
  return row.cells.some((cell) => (figureTokens(cell)?.length ?? 0) >= 2);
}

/** A cell's figures as printed, normalised for comparison; null when it holds anything but figures. */
function figureTokens(cell: string): string[] | null {
  const list = joinBrackets(tokens(cell)).map((token) => normal(token.text));
  return list.every(isFigure) ? list : null;
}

function normal(text: string): string {
  return text.replace(/[–—−]/gu, '-');
}

function isFigure(text: string): boolean {
  return parseFigure(text) !== null;
}

function isDash(text: string): boolean {
  return /^[-–—]+$/u.test(text);
}

/** A note reference ("16", "3.1.4", "10.1," or "&" in "10.1, 12.1 & 13.3"): never a value. */
function isNoteToken(text: string): boolean {
  return /^\d{1,2}(?:\.\d{1,2}){0,2},?$/u.test(text) || text === '&';
}

const NOTE_REF = /^\d{1,2}(?:\.\d{1,2}){0,2}(?:\s*[&,]\s*\d{1,2}(?:\.\d{1,2}){0,2})*$/u;
/** A figure no caption or note resembles: a thousands separator or four digits. */
const DISTINCT = /\d,\d{3}|\d{4}/u;
/** Words the lines may print beyond those the table model read, when their order differs. */
const MAX_EXTRA = 2;
/** Rows a block may become, "a" to "z". */
const MAX_LINES = 26;
/** Pairings a block may take in on either side when its captions do not close within it. */
const MAX_ABSORB = 3;
/** Caption-only lines above a block that can hold its first row's headings. */
const MAX_PRE = 3;

interface Placed {
  /** Index of the line in the page text. */
  index: number;
  /** The line's figure per value column, normalised; null where it prints none. */
  cells: Array<string | null>;
  caption: string;
  note: string | null;
  /** A figure within the columns' span that fits no column, or two in one column. */
  unclear: boolean;
}

interface Geometry {
  anchors: number[];
  tolerance: number;
  /** Where the leftmost column's figures can start. */
  spanStart: number;
  capLeft: number;
  capRight: number;
}

function rebuildPiece(rows: StatementRow[], lines: Token[][]): { rows: StatementRow[]; rebuilt: StatementRow[]; blocks: number } {
  const unchanged = { rows, rebuilt: [] as StatementRow[], blocks: 0 };
  const columns = rows[0]?.cells.length ?? 0;
  if (columns === 0 || !rows.some(isFused)) return unchanged;
  const cells = rows.map((row) => row.cells.map(figureTokens));
  const geometry = measure(rows, cells, lines, columns);
  if (!geometry) return unchanged;
  const placed = lines.map((line, index) => place(line, index, geometry, columns));
  const figureLines = placed.filter((line) => line.unclear || line.cells.some((cell) => cell !== null));

  // Rows paired with lines in order (longest common subsequence over exact matches).
  const R = rows.length;
  const F = figureLines.length;
  const match = (r: number, f: number): boolean => {
    const line = figureLines[f]!;
    const row = cells[r]!;
    if (line.unclear || row.some((cell) => cell === null || cell.length > 1) || row.every((cell) => cell!.length === 0)) return false;
    if (!row.every((cell, c) => (cell![0] ?? null) === line.cells[c])) return false;
    return row.some((cell) => DISTINCT.test(cell![0] ?? '')) || captionAgrees(rows[r]!.label, line.caption);
  };
  const dp = Array.from({ length: R + 1 }, () => new Int32Array(F + 1));
  for (let r = 1; r <= R; r++) {
    for (let f = 1; f <= F; f++) dp[r]![f] = Math.max(dp[r - 1]![f]!, dp[r]![f - 1]!, match(r - 1, f - 1) ? dp[r - 1]![f - 1]! + 1 : 0);
  }
  const pairs: Array<[number, number]> = [];
  for (let r = R, f = F; r > 0 && f > 0; ) {
    if (match(r - 1, f - 1) && dp[r]![f] === dp[r - 1]![f - 1]! + 1) {
      pairs.unshift([r - 1, f - 1]);
      r--;
      f--;
    } else if (dp[r]![f] === dp[r - 1]![f]) r--;
    else f--;
  }
  // A pairing whose caption disagrees with the line's (the table model filed the caption of the
  // line above or below with these figures) is not a pairing: the row joins the block around it,
  // which is rebuilt with the rest.
  const misfiled = new Set<number>();
  for (const [r, f] of pairs) if (!captionsMatch(rows[r]!.label, figureLines[f]!, placed)) misfiled.add(r);
  pairs.splice(0, pairs.length, ...pairs.filter(([r]) => !misfiled.has(r)));
  if (pairs.length === 0) return unchanged;
  const broken = (from: number, to: number) => rows.slice(from, to).some((row, j) => isFused(row) || misfiled.has(from + j));

  // Each block with a fused or misfiled row, alone or, when its captions do not close within it
  // (the table model's caption boundaries can differ from its figure boundaries), together with
  // up to MAX_ABSORB pairings on either side, fewest first; exact captions at every size first.
  const bounds: Array<[number, number]> = [[-1, -1], ...pairs, [R, F]];
  const last = bounds.length - 1;
  const replaced: Array<{ from: number; to: number; rows: StatementRow[] }> = [];
  let floor = 0;
  for (let k = 0; k < last; k++) {
    if (!broken(bounds[k]![0] + 1, bounds[k + 1]![0])) continue;
    let reached = -1;
    for (const loose of [false, true]) for (let size = 0; size <= 2 * MAX_ABSORB && reached < 0; size++) {
      for (let above = Math.min(size, MAX_ABSORB); above >= 0 && reached < 0; above--) {
        const below = size - above;
        const low = k - above;
        const high = k + 1 + below;
        if (below > MAX_ABSORB || low < floor || high > last || (low === 0 && high === last)) continue;
        const [r0, f0] = bounds[low]!;
        const [r1, f1] = bounds[high]!;
        const barriers = rows.slice(r0 + 1, r1).map((_, j) => r0 + 1 + j).filter((r) => cells[r]!.some((cell) => cell === null));
        if (barriers.length > 0 && size > 0) continue;
        // A row with anything but figures in a cell (a unit caption read into a value column)
        // cannot be compared with a line: the rows before it are read down from the pairing above,
        // the rows after it up from the pairing below, and rows between two such rows are left alone.
        const parts: Array<{ from: number; to: number; mode: Mode }> =
          barriers.length === 0
            ? [{ from: r0 + 1, to: r1, mode: low === 0 ? 'up' : high === last ? 'down' : 'between' }]
            : [
                ...(low === 0 ? [] : [{ from: r0 + 1, to: barriers[0]!, mode: 'down' as Mode }]),
                ...(high === last ? [] : [{ from: barriers.at(-1)! + 1, to: r1, mode: 'up' as Mode }]),
              ];
        let lo = f0;
        for (const part of parts) {
          if (!broken(part.from, part.to)) continue;
          const made = rebuildBlock(rows.slice(part.from, part.to), cells.slice(part.from, part.to), figureLines, placed, lo, f1, part.mode, loose);
          if (!made) continue;
          replaced.push({ from: part.from, to: part.to, rows: made.rows });
          lo = made.lastLine;
          reached = high;
        }
        if (barriers.length > 0) reached = Math.max(reached, k + 1);
      }
    }
    if (reached > 0) {
      floor = reached;
      k = reached - 1;
    }
  }
  const out: StatementRow[] = [];
  const rebuilt: StatementRow[] = [];
  for (let r = 0; r < R; ) {
    const change = replaced.find((item) => item.from === r);
    if (change && change.to > r) {
      out.push(...change.rows);
      rebuilt.push(...change.rows);
      r = change.to;
    } else out.push(rows[r++]!);
  }
  const blocks = replaced.length;
  return { rows: out, rebuilt, blocks };
}

/**
 * Column positions and the caption band from the clean rows found on exactly one line (step 1);
 * null when they do not agree.
 */
function measure(rows: StatementRow[], cells: Array<Array<string[] | null>>, lines: Token[][], columns: number): Geometry | null {
  const edges: number[][] = Array.from({ length: columns }, () => []);
  const widths = new Array<number>(columns).fill(0);
  const starts: number[] = [];
  for (const [r, row] of cells.entries()) {
    if (row.some((cell) => cell === null || cell.length > 1)) continue;
    const wanted = row.map((cell, c) => ({ c, text: cell![0] })).filter((item): item is { c: number; text: string } => item.text !== undefined);
    if (wanted.length === 0 || !wanted.some((item) => DISTINCT.test(item.text))) continue;
    const found: Array<{ line: Token[]; at: number[] }> = [];
    for (const line of lines) {
      const at = runOf(line, wanted.map((item) => item.text));
      if (at) found.push({ line, at });
    }
    if (found.length !== 1) continue;
    const { line, at } = found[0]!;
    wanted.forEach((item, k) => {
      const token = line[at[k]!]!;
      if (!isDash(token.text)) edges[item.c]!.push(token.end);
      widths[item.c] = Math.max(widths[item.c]!, token.end - token.start);
    });
    // Where the caption starts: the first of a run of tokens on the line whose words are exactly
    // the caption's (a note reference may follow). A caption that wraps onto two lines gives none.
    const label = captionWords(rows[r]!.label);
    const start = label.length > 0 ? captionStart(line, label) : null;
    if (start !== null) starts.push(start);
  }
  if (edges.some((list) => list.length < 2) || starts.length === 0) return null;
  const anchors = edges.map(median);
  for (const [c, list] of edges.entries()) {
    if (list.filter((edge) => Math.abs(edge - anchors[c]!) <= 2).length < list.length * 0.6) return null;
  }
  for (let c = 1; c < columns; c++) if (anchors[c]! - anchors[c - 1]! < 3) return null;
  const gaps = anchors.slice(1).map((anchor, c) => anchor - anchors[c]!);
  const tolerance = Math.max(2, Math.min(6, Math.min(...(gaps.length > 0 ? gaps : [12])) * 0.45));
  const capStart = Math.min(...starts);
  const leftOf = anchors.filter((anchor) => anchor < capStart);
  const capLeft = Math.max(capStart - 6, leftOf.length > 0 ? Math.max(...leftOf) + 1 : 0);
  // Caption words end before the first value column to their right.
  const capRight = anchors.find((anchor) => anchor > capStart);
  if (capRight === undefined) return null;
  const spanStart = anchors[0]! - widths[0]! - 2;
  return { anchors, tolerance, spanStart, capLeft, capRight };
}

/**
 * Token positions of `wanted` on a line: the line's figures in order, with nothing but note
 * references skipped between them (a caption may sit between two groups of columns, as on a bank's
 * US dollar and rupee columns). Null when not found or found twice.
 */
function runOf(line: Token[], wanted: string[]): number[] | null {
  const figures = line.map((token, index) => ({ text: normal(token.text), index })).filter((token) => isFigure(token.text) || isDash(token.text));
  let result: number[] | null = null;
  for (let i = 0; i < figures.length; i++) {
    if (figures[i]!.text !== wanted[0]) continue;
    const at = [figures[i]!.index];
    let j = i + 1;
    for (let k = 1; k < wanted.length && j <= figures.length; ) {
      if (j === figures.length) break;
      if (figures[j]!.text === wanted[k]) {
        at.push(figures[j]!.index);
        k++;
      } else if (!isNoteToken(figures[j]!.text)) break;
      j++;
    }
    if (at.length !== wanted.length) continue;
    if (result) return null;
    result = at;
  }
  return result;
}

function captionStart(line: Token[], label: string[]): number | null {
  const list = line.map((token) => ({ token, words: captionWords(normal(token.text)) }));
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.words.length === 0) continue;
    const found: string[] = [];
    for (let j = i; j < list.length && found.length < label.length; j++) {
      if (list[j]!.words.length === 0) {
        if (isNoteToken(normal(list[j]!.token.text)) || /^[^\w]+$/u.test(list[j]!.token.text)) continue;
        break;
      }
      found.push(...list[j]!.words);
    }
    if (wordsEqual(found, label)) return list[i]!.token.start;
  }
  return null;
}

/** One line's figures by column, its caption and note (step 2). */
function place(line: Token[], index: number, geometry: Geometry, columns: number): Placed {
  const { anchors, tolerance, spanStart, capLeft, capRight } = geometry;
  const cells = new Array<string | null>(columns).fill(null);
  let unclear = false;
  // Everything in the caption band that is not placed in a column, in order: the caption, then
  // the note reference printed after it ("10.1, 12.1 & 13.3"). A dash or a number inside the
  // caption ("Sales - net", "IFRS 9") stays in it.
  const band: string[] = [];
  for (const token of line) {
    const text = normal(token.text);
    const inCaption = token.start >= capLeft && token.end <= capRight;
    if (isFigure(text) || isDash(text)) {
      const at = isDash(text) ? (token.start + token.end) / 2 : token.end;
      let best = -1;
      let distance = Infinity;
      anchors.forEach((anchor, c) => {
        if (Math.abs(anchor - at) < distance) [best, distance] = [c, Math.abs(anchor - at)];
      });
      if (distance <= (isDash(text) ? tolerance + 3 : tolerance)) {
        if (cells[best] !== null) unclear = true;
        cells[best] = text;
        continue;
      }
      // A figure among the columns that fits none of them, or an amount in the caption band (a
      // column the table model did not read). A note reference is never one.
      if (!isNoteToken(text) && !isDash(text) && token.end <= anchors.at(-1)! + tolerance && (token.end > spanStart || (inCaption && /\d,\d{3}/u.test(text)))) {
        unclear = true;
        continue;
      }
    }
    if (inCaption) band.push(token.text);
  }
  const note: string[] = [];
  while (band.length > 0 && isNoteToken(normal(band.at(-1)!))) note.unshift(band.pop()!);
  while (note[0] === '&') band.push(note.shift()!);
  const caption = band;
  const noteText = note.join(' ').replace(/\s*,\s*/gu, ', ').replace(/,$/u, '');
  return { index, cells, caption: caption.join(' '), note: NOTE_REF.test(noteText) ? noteText : null, unclear };
}

/**
 * One block of rows rebuilt from lines (step 3), or null when the figures or the captions do not
 * match exactly. `f0` and `f1` are the figure lines paired with the rows around the block (-1 and
 * the line count when there is none).
 */
function rebuildBlock(
  block: StatementRow[],
  cells: Array<Array<string[] | null>>,
  figureLines: Placed[],
  placed: Placed[],
  lo: number,
  hi: number,
  mode: Mode,
  loose: boolean,
): { rows: StatementRow[]; lastLine: number } | null {
  if (cells.some((row) => row.some((cell) => cell === null))) return null;
  const columns = cells[0]!.length;
  const queues = Array.from({ length: columns }, (_, c) => cells.flatMap((row) => row[c]!));
  const empty = () => queues.every((queue) => queue.length === 0);
  const used: Placed[] = [];
  const take = (line: Placed, pop: boolean): boolean => {
    if (line.unclear) return false;
    // A note reference the table model read into a value cell ("13.3 (18,055)") is dropped when
    // the line prints it as its note.
    const notes = (line.note ?? '').split(/[\s,&]+/u).filter(Boolean);
    for (let c = 0; c < columns; c++) {
      const queue = queues[c]!;
      const head = pop ? queue.at(-1) : queue[0];
      if (head !== undefined && head !== line.cells[c] && isNoteToken(head) && notes.includes(head)) {
        if (pop) queue.pop();
        else queue.shift();
      }
    }
    for (let c = 0; c < columns; c++) {
      const cell = line.cells[c];
      if (cell === null || cell === undefined) continue;
      if ((pop ? queues[c]!.at(-1) : queues[c]![0]) !== cell) return false;
      if (pop) queues[c]!.pop();
      else queues[c]!.shift();
    }
    return true;
  };
  if (mode === 'up') {
    // Up from the pairing below until the figures run out.
    for (let f = hi - 1; f > lo && !empty(); f--) {
      if (!take(figureLines[f]!, true)) return null;
      used.unshift(figureLines[f]!);
    }
  } else {
    for (let f = lo + 1; f < hi && !empty(); f++) {
      if (!take(figureLines[f]!, false)) return null;
      used.push(figureLines[f]!);
    }
    // Between two pairings every line between them must be used, and nothing else.
    if (mode === 'between' && used.length !== hi - lo - 1) return null;
  }
  if (!empty()) return null;
  if (used.length === 0 || used.length > MAX_LINES) return null;

  const from = used[0]!.index;
  const to = used.at(-1)!.index;
  const firstUsed = figureLines.indexOf(used[0]!);
  const floor = firstUsed > 0 ? figureLines[firstUsed - 1]!.index : -1;
  const captionOnly = (line: Placed) => !line.unclear && line.cells.every((cell) => cell === null) && captionWords(line.caption).length > 0;
  if (placed.slice(from, to + 1).some((line) => line.unclear)) return null;
  const core = placed.slice(from, to + 1).filter((line) => used.includes(line) || captionOnly(line));
  const pre = placed.slice(floor + 1, from).filter(captionOnly).slice(-MAX_PRE);
  const plan = planCaptions(block, core, pre, loose);
  if (!plan) return null;

  const same = plan.length === block.length && plan.every((item, j) => wordsEqual(captionWords(item.label), captionWords(block[j]!.label)));
  const rows = plan.map((item, j): StatementRow => {
    const cellsOut = item.line.cells.map((cell) => cell ?? '');
    return {
      id: same ? block[j]!.id : `${block[0]!.id}${String.fromCharCode(97 + j)}`,
      page: block[0]!.page,
      label: item.label,
      cells: cellsOut,
      values: cellsOut.map(parseFigure),
      note: item.line.note,
      headings: item.headings,
      ocr: false,
    };
  });
  return { rows, lastLine: figureLines.indexOf(used.at(-1)!) };
}

/** How a block's lines are found: all lines between two pairings, or read down or up from one. */
type Mode = 'between' | 'down' | 'up';

interface Planned {
  line: Placed;
  label: string;
  headings: string[];
}

/**
 * Each used line's caption and headings, when the block's words (its headings and captions) are
 * exactly the words of the lines. Tried with the caption-only lines just above the block standing
 * for its first row's headings (nearest first), then without them (the first row keeps the
 * headings the table model gave it).
 */
function planCaptions(block: StatementRow[], core: Placed[], pre: Placed[], loose: boolean): Planned[] | null {
  const own = (withFirst: boolean) =>
    block.flatMap((row, j) => [
      ...(j > 0 || withFirst ? row.headings.flatMap((text) => captionWords(text).map((word) => ({ word, heading: true }))) : []),
      ...captionWords(row.label).map((word) => ({ word, heading: false })),
    ]);
  const attempts: Array<{ lines: Placed[]; expected: Array<{ word: string; heading: boolean }>; inherited: string[] }> = [];
  for (let k = pre.length; k >= 0; k--) attempts.push({ lines: [...pre.slice(pre.length - k), ...core], expected: own(true), inherited: [] });
  attempts.push({ lines: core, expected: own(false), inherited: block[0]!.headings });
  for (const { lines, expected, inherited } of attempts) {
    const flags = loose ? alignLoose(lines, expected, block) : align(lines, expected);
    if (!flags) continue;
    const plan = assemble(lines, flags, inherited);
    if (plan) return plan;
  }
  return null;
}

/** Per line, whether its words were headings (true), captions (false) or both (null); null when the words differ. */
function align(lines: Placed[], expected: Array<{ word: string; heading: boolean }>): Array<boolean | null> | null {
  const flags: Array<boolean | null> = [];
  let at = 0;
  for (const line of lines) {
    const list = captionWords(line.caption);
    const seen = new Set<boolean>();
    for (const word of list) {
      const want = expected[at++];
      if (!want || !sameWord(word, want.word, 'layout')) return null;
      seen.add(want.heading);
    }
    flags.push(seen.size === 1 ? [...seen][0]! : seen.size === 0 ? false : null);
  }
  return at === expected.length ? flags : null;
}

/**
 * The same words in another order (the table model can file a caption's last words as a heading
 * of its row); every word the table model read must be on the lines, which may print up to
 * MAX_EXTRA words it lost, or one figure line's whole caption. A caption-only line is a heading
 * when it is exactly one of the block's headings, else part of a caption.
 */
function alignLoose(lines: Placed[], expected: Array<{ word: string; heading: boolean }>, block: StatementRow[]): Array<boolean | null> | null {
  const pool = expected.map((item) => item.word);
  const headings = block.flatMap((row) => row.headings).map(captionWords).filter((list) => list.length > 0);
  const flags: Array<boolean | null> = [];
  let lost = 0;
  let extra = 0;
  for (const line of lines) {
    const list = captionWords(line.caption);
    const taken: number[] = [];
    for (const word of list) {
      const index = pool.findIndex((other, i) => !taken.includes(i) && sameWord(word, other, 'layout'));
      if (index >= 0) taken.push(index);
    }
    const figures = line.cells.some((cell) => cell !== null);
    if (taken.length === 0 && list.length > 0 && figures && lost === 0) lost = 1;
    else extra += list.length - taken.length;
    if (extra > MAX_EXTRA) return null;
    for (const index of taken.sort((a, b) => b - a)) pool.splice(index, 1);
    flags.push(!figures && headings.some((heading) => wordsEqual(heading, list)));
  }
  return pool.length === 0 ? flags : null;
}

function assemble(lines: Placed[], flags: Array<boolean | null>, inherited: string[]): Planned[] | null {
  const plan: Planned[] = [];
  let headings = [...inherited];
  let prefix: string[] = [];
  for (const [i, line] of lines.entries()) {
    const figures = line.cells.some((cell) => cell !== null);
    if (figures) {
      plan.push({ line, label: [...prefix, line.caption].filter(Boolean).join(' '), headings });
      headings = [];
      prefix = [];
      continue;
    }
    const flag = flags[i];
    if (flag === null || flag === undefined) return null;
    if (flag) {
      if (prefix.length > 0) return null;
      headings.push(line.caption);
    } else if (/^[a-z]/u.test(line.caption) && prefix.length === 0 && headings.length === 0 && plan.length > 0) {
      plan.at(-1)!.label = `${plan.at(-1)!.label} ${line.caption}`.trim();
    } else prefix.push(line.caption);
  }
  return prefix.length === 0 && headings.length === 0 ? plan : null;
}

function captionWords(text: string): string[] {
  return words(text.normalize('NFKC'));
}

function wordsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((word, i) => sameWord(word, b[i]!, 'layout'));
}

/** A row's caption and a line's agree: at least half the caption's words are on the line (or both are blank). */
function captionAgrees(label: string, caption: string): boolean {
  const mine = captionWords(label);
  const theirs = captionWords(caption);
  if (mine.length === 0) return theirs.length === 0;
  const found = mine.filter((word) => theirs.some((other) => sameWord(word, other, 'layout'))).length;
  return found * 2 >= mine.length;
}

/**
 * A paired row's caption agrees with its line: two thirds of its words are in the line's caption
 * (with up to two caption-only lines just above it, a caption that wraps), and at least half the
 * line's own caption words are in it. A blank caption agrees only with a blank one.
 */
function captionsMatch(label: string, line: Placed, placed: Placed[]): boolean {
  const mine = captionWords(label);
  const own = captionWords(line.caption);
  if (mine.length === 0 || own.length === 0) return mine.length === 0 && own.length === 0;
  const above: string[] = [];
  for (let i = line.index - 1; i >= 0 && i >= line.index - 2; i--) {
    const other = placed[i]!;
    if (other.unclear || other.cells.some((cell) => cell !== null) || !other.caption) break;
    above.unshift(...captionWords(other.caption));
  }
  const found = (needles: string[], hay: string[]) => needles.filter((word) => hay.some((other) => sameWord(word, other, 'layout'))).length;
  return found(mine, [...above, ...own]) * 3 >= mine.length * 2 && found(own, mine) * 2 >= own.length;
}

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

