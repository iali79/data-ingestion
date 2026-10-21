import { describe, expect, it } from 'vitest';
import { cleanName, isInsiderDisclosureTitle, parseInsiderDisclosure, readDate, splitPerson, tidyName } from '../src/insider.js';

/** Layouts follow real PSX notices, with invented people and companies. */
const STANDARD = `
Subject: Disclosure of Interest under Regulation 5.6.4
details are as under:
            Name of                                                                                          Cumulative
                                                         Details of Transaction(s)                          Shareholding
 Sr
            Person(s)             Form of
 No.                                                                                  No. of              Number
               with                Share          Market         Date       Nature              Rate                         %
                                                                                     Share(s)             of shares
           Description       Certificate(s)
           Zara Example
  1                                  CDC           Ready      04-02-2026     Buy     27,500     39.36     1,490,772      2.00
        (Elected Director)
You may please inform the TRE Certificate Holders of the Exchange accordingly.
Yours Sincerely,
`;

const WRAPPED_DATES = `
details are as under:
  S.       Name of             From of        Market        Date        Nature        No of      Average      Number     Percentage
 No.     Persons with           Share                                                Shares       Price       of Shares
          Description       Certificates(s)
  1.    Example                  CDC          Ready         03-09-     Sale          46,000        48.79      2,484,905     0.51
        Holdings (Pvt.)                                       2025
        Limited
  2     Example                  CDC          Ready         04-09-     Sale          30,000        46.00      2,454,905     0.50
        Holdings (Pvt.)                                       2025
        Limited
We confirm that the said transactions will be presented in the subsequent board meeting.
`;

const SHARED_NAME = `
                Name of Relevant     Form of
                Persons(s)with       Share                                              No. of                 Number of
                                                  Market         Date       Nature    Share(s)        Rate       Shares
                Mr. Sample Person                  Through
                                   CDC                        04-09-2025    Purchase         152       210.00   25,019,130
                (Director)                       cc
                                   CDC                        04-09-2025    Purchase           1       214.00   25,019,131
Yours Sincerely,
`;

/** A text-layer notice with whole-number rates and no cumulative columns (Systems Limited, September 2026). */
const WHOLE_NUMBER_RATES = `
Subject: Disclosure of Interest by a Director, CEO, substantial shareholder or executive of a listed
company u/s 5.6.4 of the PSX Regulations
    Name of Person                                                 Date of Trade Nature of                      No. of           Rate      Market
                                                                                 Trade                          shares
    Ms. Ammara Masood                                              11-Sep-2026            Sell                  500,000          117       Ready
    (Senior Management)
    Ms. Ammara Masood                                              18-Sep-2026            Sell                  203,000          122.14    Ready
    (Senior Management)
    Ms. Ammara Masood                                              23-Sep-2026            Sell                  100,000          122       Ready
    (Senior Management)
We confirm that the said transaction(s) will be presented in the subsequent board meeting of the
`;

/** The number of shares sits before the nature column; the second row repeats the person's trade. */
const QUANTITY_BEFORE_NATURE = `
Subject: Transaction of Shares - Disclosure of Interest under PSX Regulations
details are as follows:
                                                    Nature of   Rate per                     Form of Share
 S. No.            Name          No. of Shares   Transaction  share (Rs.)       Date          Certificates
       1    Example Person            500           Buy         115.50       30.01.2024    Electronically - CDC
                                      500           Buy         116.00       30.01.2024    Electronically - CDC
                                    1,000
You may please inform the TRE Certificate holders of the Exchange accordingly.
`;

/** A letterhead under the table prints addresses and telephone numbers; they are not part of the name. */
const LETTERHEAD_BELOW = `
details are as under:
      Name        of                                   Details of Transaction(s)                          Cumulative Shareholding
Sr.   Relevant
No.   Person(s) with           Form of
                                                                                         No. of                      No. of
      Description               Share         Market          Date           Nature    Shares      Rate        Shares       Percentage
                             Certificate(s)
      M/s.     Example
      Holdings (Pvt.)
      Ltd.
1.                                CDC         Ready        19-12-2024          Buy          165    350.00      285,040,487    91.80%
      (Substantial
      Shareholder/
      Sponsor)
                                                                         Example Centre,           Example Centre,         Example Centre,
                                                                         15-Cub Road,               11-B, Lala Zar,         1- Ahmad Block,
                                                                         Faisalabad,                M. T. Khan Road,        New Garden Town,
                                                                         Pakistan.                  Karachi, Pakistan.
                                                                                 1
                                                                         Tel 92 41 2617836
                                                                         Fax 92 41 2617842
`;

describe('insider disclosure notices', () => {
  it('reads a table that prints the quantity before the nature column', () => {
    const rows = parseInsiderDisclosure(QUANTITY_BEFORE_NATURE, { publishedAt: new Date('2024-02-01') });
    expect(rows.map((r) => [r.date, r.person, r.nature, r.quantity, r.rate])).toEqual([
      ['2024-01-30', 'Example Person', 'buy', 500, 115.5],
      ['2024-01-30', 'Example Person', 'buy', 500, 116],
    ]);
  });

  it('keeps a letterhead printed under the table out of the last row', () => {
    const [row] = parseInsiderDisclosure(LETTERHEAD_BELOW, { publishedAt: new Date('2024-12-20') });
    expect(row).toMatchObject({ date: '2024-12-19', person: 'M/s. Example Holdings (Pvt.) Ltd.', nature: 'buy', quantity: 165, rate: 350, cumulativeShares: 285_040_487 });
  });

  it('reads a whole-number rate as the rate when the table has no cumulative columns', () => {
    const rows = parseInsiderDisclosure(WHOLE_NUMBER_RATES, { publishedAt: new Date('2026-10-01') });
    expect(rows.map((r) => [r.date, r.quantity, r.rate, r.cumulativeShares, r.designation])).toEqual([
      ['2026-09-11', 500_000, 117, null, 'Senior Management'],
      ['2026-09-18', 203_000, 122.14, null, 'Senior Management'],
      ['2026-09-23', 100_000, 122, null, 'Senior Management'],
    ]);
  });

  it('trims scan debris from the ends of a name and refuses what stays broken', () => {
    expect(tidyName('C c LSE Ventures Limited')).toBe('LSE Ventures Limited');
    expect(tidyName('Yoi:• u Muhammad Sohail Khan')).toBe('Muhammad Sohail Khan');
    expect(tidyName('Mr. Farhan Abbas Sheikh June')).toBe('Mr. Farhan Abbas Sheikh');
    expect(tidyName('Certifi M/s. Example Holdings (Pvt.) Ltd.')).toBe('M/s. Example Holdings (Pvt.) Ltd.');
    expect(tidyName('Tran Example Person')).toBe('Example Person');
    expect(tidyName('Example Person - Preference Substantial Shareholder')).toBe('Example Person');
    expect(cleanName(tidyName('Ce l. !Mr. Javed Ahmed ,Executive of rA,foezan Bank)'))).toBe(false);
  });

  it('does not read a row number or a rate as the holding after the trade', () => {
    const SERIAL = `
details are as under:
  Name of Person        Market    Date          Nature    No. of shares    Rate      Cumulative shares   %
  Artistic Holdings Ltd   Ready   12-03-2026    Purchase     250,000       81.95     1
  Muhammad Aminuddin      Ready   13-03-2026    Purchase     500,000       10
Yours Sincerely,
`;
    const [first, second] = parseInsiderDisclosure(SERIAL, { publishedAt: new Date('2026-03-14') });
    expect(first).toMatchObject({ quantity: 250_000, rate: 81.95, cumulativeShares: null });
    // Only two figures on a purchase: the second is below the shares bought, so it is the rate.
    expect(second).toMatchObject({ quantity: 500_000, rate: 10, cumulativeShares: null });
  });

  it('refuses scan debris and a bare role as a person', () => {
    expect(cleanName('& Industries Ltd. wa i Al-No')).toBe(false);
    expect(cleanName('Substantial')).toBe(false);
    expect(cleanName('Mr. A. B. Khan')).toBe(true);
    expect(cleanName('National Investment (Unit) Trust')).toBe(true);
    expect(cleanName('Ms. Ammara Masood')).toBe(true);
  });

  it('reads a standard PSX table: person, role, date, nature, quantity, rate and cumulative holding', () => {
    const [row] = parseInsiderDisclosure(STANDARD, { publishedAt: new Date('2026-02-06') });
    expect(row).toMatchObject({ date: '2026-02-04', person: 'Zara Example', designation: 'Elected Director', nature: 'buy', quantity: 27_500, rate: 39.36, market: 'Ready', cumulativeShares: 1_490_772, cumulativePercent: 2 });
  });

  it('joins a date split over two lines and keeps (Pvt.) as part of a company name', () => {
    const rows = parseInsiderDisclosure(WRAPPED_DATES, { publishedAt: new Date('2025-09-05') });
    expect(rows.map((r) => [r.date, r.person, r.nature, r.quantity, r.rate])).toEqual([
      ['2025-09-03', 'Example Holdings (Pvt.) Limited', 'sell', 46_000, 48.79],
      ['2025-09-04', 'Example Holdings (Pvt.) Limited', 'sell', 30_000, 46],
    ]);
  });

  it('carries a name down to the rows below it, with lower confidence', () => {
    const rows = parseInsiderDisclosure(SHARED_NAME, { publishedAt: new Date('2025-09-05') });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.person)).toEqual(['Mr. Sample Person', 'Mr. Sample Person']);
    expect(rows[1]!.confidence).toBeLessThan(rows[0]!.confidence);
  });

  it('rejects a future trade date and an implausibly old one against the publish date', () => {
    expect(parseInsiderDisclosure(STANDARD, { publishedAt: new Date('2026-01-01') })).toEqual([]);
    expect(parseInsiderDisclosure(STANDARD, { publishedAt: new Date('2027-06-01') })).toEqual([]);
  });

  it('reads nothing from prose that mentions buying and selling, and nothing from an empty notice', () => {
    expect(parseInsiderDisclosure('We confirm that units were sold and subsequently purchased on 28 July 2026 as clarified.')).toEqual([]);
    expect(parseInsiderDisclosure('')).toEqual([]);
  });

  it('reads the date formats the notices use', () => {
    expect(readDate('2026-02-26')).toBe('2026-02-26');
    expect(readDate('29-01-2026')).toBe('2026-01-29');
    expect(readDate('06-Feb-26')).toBe('2026-02-06');
    expect(readDate('04-JUNE-26')).toBe('2026-06-04');
    expect(readDate('Feb 28, 2025')).toBe('2025-02-28');
    expect(readDate('0409-2025')).toBe('2025-09-04');
    expect(readDate('31-02-2026')).toBeNull();
  });

  it('splits a role from a name and refuses column titles as a name', () => {
    expect(splitPerson('Mahmood Ahmad (Director)')).toEqual({ person: 'Mahmood Ahmad', designation: 'Director' });
    expect(splitPerson('Brig Saad Saeed Naik (Retd) (Executive)')).toEqual({ person: 'Brig Saad Saeed Naik (Retd)', designation: 'Executive' });
    expect(cleanName('Buyer Certificates')).toBe(false);
    expect(cleanName('Sep 05 2024 B')).toBe(false);
    expect(cleanName('Mr. Haroon Khan')).toBe(true);
  });

  it('recognises the notice titles', () => {
    expect(isInsiderDisclosureTitle('Disclosure of Interest by a Director CEO, or Executive of a listed company and their Spouses and the Substantial Shareholders u/c 5.6.1.(d) of PSX Regulations')).toBe(true);
    expect(isInsiderDisclosureTitle('Financial Results for the Year Ended 30-06-2026')).toBe(false);
  });
});
