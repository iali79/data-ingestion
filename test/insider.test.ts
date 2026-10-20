import { describe, expect, it } from 'vitest';
import { cleanName, isInsiderDisclosureTitle, parseInsiderDisclosure, readDate, splitPerson } from '../src/insider.js';

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

describe('insider disclosure notices', () => {
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
