/**
 * OGRA's daily "Price Publication": the build-up of the pump price of petrol (MS) and diesel (HSD),
 * one PDF per effective date, published on https://www.ogra.org.pk/price-publications.
 *
 * Read from the PDF's text layer (`pdftotext -layout`). The wording of a row and the set of rows
 * changed between 21 July and 18 November 2026 (a refinery-levy line and a rounding line were added;
 * the diesel crude and premium rows were renamed; on 18 November diesel's rounding split into a
 * daily and a cumulative line), so rows are matched by what they say, not by
 * position or by the formula letter, and every arithmetic identity the document states is checked
 * only when the rows it needs are present.
 *
 * Two tiers of checks:
 *  - the pump-price chain (ex-refinery price, margins, levies, the printed total): every applicable
 *    identity must hold to rounding, or the product comes back with no rows and the failed checks named;
 *  - the crude build-up (benchmark, freight, exchange rate, customs, up to the ex-refinery price): if it
 *    does not add up, the build-up rows are left out and the pump-price chain is delivered, with the
 *    failed check marked `advisory`. OGRA's own 12-19 August 2026 diesel tables do exactly this (the
 *    printed ex-refinery price is 0.22 below its parts, and everything after it is consistent with the
 *    printed figure), and refusing the day would throw away a pump price that is right.
 */

export type OgraProduct = 'MS' | 'HSD';

/** Closed list of components; the ingest API validates the same list. */
export const OGRA_COMPONENTS = [
  'platts',
  'premium',
  'freight',
  'crack',
  'cnfusd',
  'fx',
  'cnfpkr',
  'incidentals',
  'oceanloss',
  'costport',
  'fxadjustment',
  'customs',
  'exrefinery',
  'ifem',
  'omcmargin',
  'dealermargin',
  'pricebeforelevies',
  'pl',
  'plrefineries',
  'pldirect',
  'csl',
  'pricebeforest',
  'salestax',
  'calculated',
  'rounding',
  'retail',
] as const;
export type OgraComponent = (typeof OGRA_COMPONENTS)[number];

export interface OgraRow {
  product: OgraProduct;
  component: OgraComponent;
  value: number;
}

export interface OgraCheck {
  id: string;
  ok: boolean;
  detail?: string;
  /** A failed advisory check withholds the crude build-up rows but not the pump-price chain. */
  advisory?: boolean;
}

export interface OgraPublication {
  /** The date the prices take effect, `YYYY-MM-DD`. */
  effectiveDate: string;
  rows: OgraRow[];
  checks: OgraCheck[];
}

/** The rows that describe how the ex-refinery price was reached from the international benchmark. */
export const BUILDUP_COMPONENTS: readonly OgraComponent[] = [
  'platts', 'premium', 'freight', 'crack', 'cnfusd', 'fx', 'cnfpkr', 'incidentals', 'oceanloss', 'costport', 'fxadjustment', 'customs',
];
const BUILDUP_CHECKS = new Set(['cnfusd', 'cnfpkr', 'costport', 'exrefinery']);

const TOLERANCE = 0.025;
/** Cost & freight in rupees is a product of three rounded figures, so it gets a little more room. */
const PRODUCT_TOLERANCE = 0.035;
const CONVERSION_LITRES_PER_BARREL = 158.98;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const UNIT = /\b(USD\/BBL|RS\/USD|LTR\/BBL|RS\/LTR)\b/u;
const NUMBER = /-?\d[\d,]*\.\d+/u;
const HEADING = /^\s*(PETROL \(MS\)|DIESEL \(HSD\)).*?Price Effective\s+(.*?),\s*\d{1,2}:\d{2}/imu;

/** Maps a row's printed label to its component, or null for a row that is not stored (conversion factor, rounding account). */
export function classifyLabel(rawLabel: string): OgraComponent | null {
  const label = rawLabel.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!label) return null;
  if (/^(opening|closing|current)\b/u.test(label)) return null;
  if (/conversion factor/u.test(label)) return null;
  if (/platts/u.test(label)) return 'platts';
  if (/^(premium including freight|aramco crude oil premium)/u.test(label)) return 'premium';
  if (/^freight and insurance/u.test(label)) return 'freight';
  if (/^hsd crack/u.test(label)) return 'crack';
  if (/^cost & freight in pak/u.test(label)) return 'cnfpkr';
  if (/^cost & freight/u.test(label)) return 'cnfusd';
  if (/^exchange rate adjustment/u.test(label)) return 'fxadjustment';
  if (/exchange rate$/u.test(label) || /^sbp avg/u.test(label)) return 'fx';
  if (/^incidentals/u.test(label)) return 'incidentals';
  if (/^ocean loss/u.test(label)) return 'oceanloss';
  if (/cost at karachi port/u.test(label)) return 'costport';
  if (/^customs duty/u.test(label)) return 'customs';
  if (/^ex-refinery/u.test(label)) return 'exrefinery';
  if (/^ifem/u.test(label)) return 'ifem';
  if (/^omc/u.test(label)) return 'omcmargin';
  if (/^dealer/u.test(label)) return 'dealermargin';
  if (/^price before pl/u.test(label)) return 'pricebeforelevies';
  if (/^price before sales tax/u.test(label)) return 'pricebeforest';
  if (/^petroleum levy \(pl\) through refineries/u.test(label)) return 'plrefineries';
  if (/^petroleum levy \(pl\) direct/u.test(label)) return 'pldirect';
  if (/^petroleum levy \(pl\)/u.test(label)) return 'pl';
  if (/^climate support levy/u.test(label)) return 'csl';
  if (/^sales tax/u.test(label)) return 'salestax';
  if (/^total (total )?calculated/u.test(label)) return 'calculated';
  // From 18 Nov 2026 the diesel table splits rounding into a daily and a cumulative line, and the
  // final price adds both (Z = W + X + Y); the two are summed into the one `rounding` component.
  if (/^(daily |cumulative )?rounding[- ]off adjustment/u.test(label)) return 'rounding';
  if (/^total (petrol|diesel) price/u.test(label)) return 'retail';
  return null;
}

/** Reads the date out of a heading's "Price Effective ..." text: "November 17,2026" or "21 July 2026". */
export function parseEffectiveDate(text: string): string | null {
  const dayFirst = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/u.exec(text);
  const monthFirst = /([A-Za-z]+)\s+(\d{1,2})\s*,?\s*(\d{4})/u.exec(text);
  const [day, month, year] = dayFirst ? [dayFirst[1]!, dayFirst[2]!, dayFirst[3]!] : monthFirst ? [monthFirst[2]!, monthFirst[1]!, monthFirst[3]!] : [];
  const m = month ? MONTHS[month.toLowerCase()] : undefined;
  if (!day || !year || !m) return null;
  const d = Number(day);
  if (d < 1 || d > 31) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseNumber(token: string): number {
  return Number(token.replace(/,/gu, ''));
}

interface Section {
  product: OgraProduct;
  effective: string | null;
  lines: string[];
}

function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/u);
  const sections: Section[] = [];
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      sections.push({ product: heading[1]!.toUpperCase().startsWith('PETROL') ? 'MS' : 'HSD', effective: parseEffectiveDate(heading[2]!), lines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]!.lines.push(line);
    }
  }
  return sections;
}

/** One product's rows, in the order printed. A repeated component keeps its first value and is reported. */
function readSection(section: Section): { values: Map<OgraComponent, number>; problems: string[] } {
  const values = new Map<OgraComponent, number>();
  const problems: string[] = [];
  let pending = '';
  for (const line of section.lines) {
    if (/^\s*Rounding Account\b/iu.test(line)) break;
    const unit = UNIT.exec(line);
    if (!unit) {
      // A label starts at the left edge; the right-hand explanation column starts far in.
      const left = line.slice(0, 60);
      if (/^\S/u.test(left) && left.trim().length > 0 && !/^(price components|\*)/iu.test(left.trim()) && !/^full impact/iu.test(left.trim())) {
        pending = pending && /\($|excl\.?$|secondary$/iu.test(pending) ? `${pending} ${left.trim()}` : left.trim();
      }
      continue;
    }
    const label = line.slice(0, unit.index).trim() || pending;
    const after = line.slice(unit.index + unit[0].length);
    const number = NUMBER.exec(after);
    pending = '';
    const component = classifyLabel(label);
    if (!component || !number) continue;
    if (component === 'rounding' && values.has(component)) {
      values.set(component, Math.round((values.get(component)! + parseNumber(number[0])) * 100) / 100);
      continue;
    }
    if (values.has(component)) {
      problems.push(`${component} is printed twice`);
      continue;
    }
    values.set(component, parseNumber(number[0]));
  }
  return { values, problems };
}

const sum = (values: Map<OgraComponent, number>, parts: OgraComponent[]): number | null =>
  parts.every((p) => values.has(p)) ? parts.reduce((total, p) => total + values.get(p)!, 0) : null;

/** Every identity the document states, applied only where its inputs are printed. */
export function checksFor(values: Map<OgraComponent, number>): OgraCheck[] {
  const checks: OgraCheck[] = [];
  const near = (id: string, actual: number | undefined, expected: number | null, tolerance = TOLERANCE) => {
    if (actual === undefined || expected === null) return;
    const ok = Math.abs(actual - expected) <= tolerance;
    checks.push({ id, ok, ...(BUILDUP_CHECKS.has(id) ? { advisory: true } : {}), ...(ok ? {} : { detail: `printed ${actual}, expected ${expected.toFixed(2)}` }) });
  };

  const crude = (['platts', 'premium', 'freight', 'crack'] as const).filter((c) => values.has(c));
  near('cnfusd', values.get('cnfusd'), crude.length > 0 ? sum(values, [...crude]) : null);
  const usd = values.get('cnfusd');
  const fx = values.get('fx');
  near('cnfpkr', values.get('cnfpkr'), usd !== undefined && fx !== undefined ? (usd * fx) / CONVERSION_LITRES_PER_BARREL : null, PRODUCT_TOLERANCE);
  near('costport', values.get('costport'), sum(values, ['cnfpkr', 'incidentals', 'oceanloss']));
  near('exrefinery', values.get('exrefinery'), sum(values, ['costport', 'fxadjustment', 'customs']));
  near('pricebeforelevies', values.get('pricebeforelevies'), sum(values, ['exrefinery', 'ifem', 'omcmargin', 'dealermargin']));
  near('pldirect', values.get('pldirect'), sum(values, ['pl', 'plrefineries']));

  const base = values.get('pricebeforelevies');
  const levy = values.get('pldirect') ?? values.get('pl');
  const csl = values.get('csl');
  const tax = values.get('salestax');
  const levied = base !== undefined && levy !== undefined && csl !== undefined && tax !== undefined ? base + levy + csl + tax : null;
  near('pricebeforest', values.get('pricebeforest'), base !== undefined && levy !== undefined && csl !== undefined ? base + levy + csl : null);
  near('calculated', values.get('calculated'), levied);
  const calculated = values.get('calculated');
  near('retail', values.get('retail'), calculated !== undefined ? calculated + (values.get('rounding') ?? 0) : levied);
  return checks;
}

/** What a price publication must at least print, or it is not a price publication. */
const REQUIRED: OgraComponent[] = ['exrefinery', 'ifem', 'omcmargin', 'dealermargin', 'pl', 'csl', 'retail'];

export function parsePricePublication(text: string): OgraPublication {
  const sections = splitSections(text);
  const rows: OgraRow[] = [];
  const checks: OgraCheck[] = [];
  const dates = new Set<string>();

  for (const section of sections) {
    if (section.effective) dates.add(section.effective);
    const { values, problems } = readSection(section);
    const own: OgraCheck[] = [
      ...REQUIRED.map((c) => ({ id: `${c}-printed`, ok: values.has(c) })),
      ...problems.map((p) => ({ id: 'duplicate', ok: false, detail: p })),
      ...checksFor(values),
    ].map((c) => ({ ...c, id: `${section.product}:${c.id}` }));
    checks.push(...own);
    if (own.every((c) => c.ok || c.advisory)) {
      const buildupBroken = own.some((c) => !c.ok && c.advisory);
      for (const [component, value] of values) {
        if (buildupBroken && BUILDUP_COMPONENTS.includes(component)) continue;
        rows.push({ product: section.product, component, value });
      }
    }
  }

  if (dates.size !== 1) {
    checks.push({ id: 'effective-date', ok: false, detail: dates.size === 0 ? 'no effective date printed' : `headings disagree: ${[...dates].join(', ')}` });
    return { effectiveDate: [...dates][0] ?? '', rows: [], checks };
  }
  if (sections.length === 0) checks.push({ id: 'sections', ok: false, detail: 'no PETROL (MS) or Diesel (HSD) heading found' });
  return { effectiveDate: [...dates][0]!, rows, checks };
}
