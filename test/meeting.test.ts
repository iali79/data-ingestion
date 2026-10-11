import { describe, expect, it } from 'vitest';
import { findDates, isBoardMeetingTitle, parseBoardMeeting, parseTime } from '../src/meeting.js';

// Sentence shapes from PSX board-meeting notices, September-October 2026.
const cases: Array<[string, string, Partial<ReturnType<typeof parseBoardMeeting>>]> = [
  [
    'month first, p.m., annual',
    'This is to inform you that a meeting of the Board of Directors of the Company will be held on Wednesday, September 30, 2026 at 03:30 p.m. at the registered office to consider the Annual accounts for period ended on June 30, 2026.',
    { date: '2026-09-30', time: '15:30', purpose: 'financial_results', resultsPeriod: 'annual', periodEnded: '2026-06-30' },
  ],
  [
    'no space before the year',
    'a meeting of the Board of Directors of the Company will be held on Tuesday, September 29,2026 at 11:00 a.m" through video link to consider the Annual Audited Accounts for the year ended June 30, 2026',
    { date: '2026-09-29', time: '11:00', resultsPeriod: 'annual' },
  ],
  [
    'nine months is a quarter',
    'a meeting of the Board of Directors of the Company is scheduled to be held on Monday, October 19, 2026 at 9:30 a.m. at Karachi to consider the financial statements for the nine months ended September 30, 2026 and the declaration of entitlement, if any.',
    { date: '2026-10-19', time: '09:30', purpose: 'financial_results', resultsPeriod: 'quarter', periodEnded: '2026-09-30' },
  ],
  [
    'day first with ordinal, scheduled on',
    'Board of Directors meeting of the Management Company is scheduled on 30th September 2026 at 03:00 pm. Inter-alia to consider financial accounts of the Fund for the period ended 30th June 2026.',
    { date: '2026-09-30', time: '15:00', purpose: 'financial_results', periodEnded: '2026-06-30' },
  ],
  [
    'time before the date',
    'a meeting of the Board of Directors of the Company will be held at 12:30 PM on September 30, 2026(Wednesday) at the registered office to discuss, consider and approve the Financial Statements for the year ended June 30, 2026',
    { date: '2026-09-30', time: '12:30' },
  ],
  [
    'numeric day first, Hrs, not results',
    'meeting of the Board of Directors of the Company will be held on 28-09-2026 at 12:30 Hrs, via zoom video conference call to consider the business other than financial results.',
    { date: '2026-09-28', time: '12:30', purpose: 'other', resultsPeriod: null },
  ],
  [
    'hours without a colon, quarter',
    'a meeting of the Board of Directors of the Company will be held on Tuesday, 29 September 2026 at 1700 hours PST at its head office, to consider the financial statements for the quarter ended March 31, 2026',
    { date: '2026-09-29', time: '17:00', resultsPeriod: 'quarter', periodEnded: '2026-03-31' },
  ],
  [
    'other than financials',
    'a meeting of the Board of Directors of the Bank will be held on Monday, October 05, 2026 at 11:00 a.m. at Executive Board Room, Head Office Building, No. 13, Clifton, Karachi to consider matters other than Financials.',
    { date: '2026-10-05', time: '11:00', purpose: 'other' },
  ],
  [
    'OCR letter O in the year',
    'meeting of the Board of Directors of the Company will be held on Friday 02nd October 2O26 at 05:45 PM, to consider the annual accounts for the year ended June 30th, 2026.',
    { date: '2026-10-02', time: '17:45', periodEnded: '2026-06-30' },
  ],
];

describe('parseBoardMeeting', () => {
  for (const [name, text, expected] of cases) {
    it(name, () => {
      expect(parseBoardMeeting(`Subject: BOARD MEETING Dear Sir, ${text}`)).toMatchObject({ kind: 'board_meeting', ...expected });
    });
  }

  it('reads nothing from a report of a meeting already held', () => {
    expect(parseBoardMeeting('the Board of Directors of the Company in their meeting held at 11:30 A.M., on Friday September 25, 2026 has approved the budget.')).toBeNull();
  });

  it('reads nothing when the sentence has no date', () => {
    expect(parseBoardMeeting('a meeting of the Board of Directors will be held shortly to consider the accounts.')).toBeNull();
  });
});

describe('helpers', () => {
  it('reads board-meeting titles, not revoked ones', () => {
    expect(isBoardMeetingTitle('Notice of Emergent Board Meeting')).toBe(true);
    expect(isBoardMeetingTitle('Board Meeting REVOKED')).toBe(false);
    expect(isBoardMeetingTitle('Financial Results for the Year Ended June 30, 2026')).toBe(false);
  });

  it('reads times, afternoon when an hour has no meridiem', () => {
    expect(parseTime('at 10: am')).toBe('10:00');
    expect(parseTime('at 12:00 p.m')).toBe('12:00');
    expect(parseTime('at 3:00')).toBe('15:00');
    expect(parseTime('at the registered office')).toBeNull();
  });

  it('rejects impossible dates', () => {
    expect(findDates('31-09-2026 and February 30, 2026')).toEqual([]);
  });
});
