import { describe, expect, it } from 'vitest';
import { cashAmount, isPayoutNoticeTitle, parsePayoutNotice } from '../src/payout.js';

/**
 * Excerpts of public PSX results notices as OCR read them in the 2026-11-02 notice sample
 * (samples/payout-notices.json), typos and all.
 */
describe('isPayoutNoticeTitle', () => {
  it('takes results, dividend and book-closure notices', () => {
    expect(isPayoutNoticeTitle('Financial Results for the year ended June 30, 2019')).toBe(true);
    expect(isPayoutNoticeTitle('NOTICE OF ANNOUNCEMENT OF INTERIM CASH DIVIDEND/BOOK CLOSURE')).toBe(true);
    expect(isPayoutNoticeTitle('Revised Book Closure')).toBe(true);
  });

  it('leaves out meeting notices and notices that follow a payout', () => {
    expect(isPayoutNoticeTitle('Board Meeting for Announcement of Financial Results for the Third Quarter')).toBe(false);
    expect(isPayoutNoticeTitle('Credit of Final Cash Dividend D-2025(F)')).toBe(false);
    expect(isPayoutNoticeTitle('Payment of Second Interim Cash Dividend D-2018')).toBe(false);
    expect(isPayoutNoticeTitle('DISBURSEMENT OF FINAL CASH DIVIDEND FOR THE YEAR ENDED JUNE 30, 2018')).toBe(false);
    expect(isPayoutNoticeTitle('PUBLISHED NOTICE UNCLAIMED DIVIDEND - LUCKY CEMENT LIMITED')).toBe(false);
  });
});

describe('parsePayoutNotice', () => {
  it('reads the 5.6.1 list and the book closure (LUCK, July 2019)', () => {
    const text = `Financial Results for the year ended June 30, 2019 We have to inform you that the Board of Directors of our Company in their Meeting held on Saturday, July 27, 2019 at 11:30 a.m. recommended the following: (I) Cash Dividend 65% (ii) Bonus Shares Nil (iii) Right Shares Nil (iv) Any other Entitlement / Corporate Action Nil (v) Any other Price-Sensitive Information Nil
      The Share Transfer Books of the Company will remain closed from Friday, September 13, 2019 to Friday, September 27, 2019 (both days inclusive).`;
    expect(parsePayoutNotice(text, { title: 'Financial Results for the year ended June 30, 2019' })).toMatchObject({
      periodEnded: '2019-06-30',
      resultsPeriod: 'annual',
      instalment: 'final',
      cashPercent: 65,
      bonusPercent: 0,
      rightPercent: 0,
      bookClosureFrom: '2019-09-13',
      bookClosureTo: '2019-09-27',
    });
  });

  it('takes this declaration, not the interim already paid (ENGRO, February 2022)', () => {
    const text = `reviewed and approved the audited standalone and consolidated financial results of the Company for the year ended December 31, 2021, and recommended the following: - Final Cash Dividend for the year ended December 31, 2021 @ Rs. 1.00 per share i.e., 10%. This is in addition to the interim dividend already paid at Rs. 24 per share i.e., 240%. - Bonus / Right Shares – Nil. The Share Transfer Books of the Company will be closed from Friday, March 18, 2022 to Thursday, March 24, 2022 (both days inclusive).`;
    expect(parsePayoutNotice(text, { title: 'FINANCIAL RESULTS FOR THE YEAR ENDED DECEMBER 31, 2021' })).toMatchObject({
      instalment: 'final',
      cashPercent: 10,
      cashPerShare: 1,
      bookClosureFrom: '2022-03-18',
      bookClosureTo: '2022-03-24',
    });
  });

  it('reads "Rs. 2.25/- per share" and stops at "already paid" (HBL, February 2022)', () => {
    expect(cashAmount(' A final Cash Dividend for the year ended December 31, 2021 at Rs. 2.25/- per share i.e. 22.5%. This is in addition to the Interim Dividend(s) already paid at Rs. 5.25/- per share i.e. 52.5%.')).toEqual({ percent: 22.5, perShare: 2.25, nil: false });
  });

  it('stops at a bracketed earlier payout (HUBC, September 2025)', () => {
    expect(cashAmount(' for the Financial year ended June 30, 2025 @ Rs. 10 per share i.e. 100%. (Interim dividends at Rs. 5 per share i.e. 50% have already been paid during the financial year)')).toEqual({ percent: 100, perShare: 10, nil: false });
  });

  it('repairs OCR in a percentage (OGDC April 2018, HUBC March 2021)', () => {
    expect(cashAmount(' Third interim cash dividend for the year 2017-18 @ Rs 2.75 per share i.e 27-5 percent, This is in addition to Interim Dividend already paid @ Rs 4.75 per share')).toMatchObject({ percent: 27.5, perShare: 2.75 });
    expect(cashAmount(' of Rs 3.00 per share (30o) on Ordinary Shares')).toMatchObject({ percent: 30, perShare: 3 });
  });

  it('declares nothing when the cash item is "no dividend" (MCB, August 2020)', () => {
    const text = `recommended the following: (i) CASH DIVIDEND No dividend has been announced for the Second Quarter ended June 30, 2020 in compliance of State Bank of Pakistan letter. The First Interim Cash Dividend has already been paid at PKR 5.0 per share i.e. 50% for the quarter ended March 31, 2020. (ii) BONUS SHARES --- NIL --- (iii) RIGHT SHARES --- NIL ---`;
    expect(parsePayoutNotice(text, { title: 'FINANCIAL RESULTS FOR THE HALF YEAR ENDED JUNE 30, 2020' })).toBeNull();
  });

  it('reads cash and bonus in one list (SYS, March 2015)', () => {
    const text = `have approved the audited financial statements for the year ended December 31, 2014 and recommended the following. Cash Dividend: 10% Bonus Shares: 10% Right Shares Nil Any other entitlement/corporate action Nil`;
    expect(parsePayoutNotice(text, { title: 'Financial Results' })).toMatchObject({ cashPercent: 10, bonusPercent: 10, rightPercent: 0 });
  });

  it('reads the prose form (PPL, September 2026)', () => {
    const text = `The Board of Directors has recommended a final cash dividend of Rs. 6.00 per share (60%) on Ordinary Shares. This is in addition to interim cash dividends of Rs. 6.00 per share (60%) on Ordinary and Rs. 3.00 per share (30%) on Convertible Preference Shares already paid during the year.`;
    expect(parsePayoutNotice(text, { title: 'Financial Results for the year ended June 30, 2026' })).toMatchObject({ instalment: 'final', cashPercent: 60, cashPerShare: 6 });
  });

  it('reads a closure with an OCR\'d "th" and the year only on the second date (LUCK, September 2016)', () => {
    const text = `recommended the following: (i) Cash Dividend 100% (ii) Bonus Shares Nil (iii) Right Shares Nil The Share Transfer Books of the Company will remain closed from Monday, 17" October to Saturday 29" October 2016 (both days inclusive).`;
    expect(parsePayoutNotice(text, { title: 'Financial Results for the year ended 30th June 2016' })).toMatchObject({ bookClosureFrom: '2016-10-17', bookClosureTo: '2016-10-29' });
  });

  it('returns null for a notice declaring only nils (TGL, April 2015)', () => {
    const text = `recommended the following: i) CASH DIVIDEND: NIL ii) BONUS ISSUE: NIL iii) RIGHT SHARES: NIL iy) OTHER PRICE SENSITIVE INFORMATION: NIL`;
    expect(parsePayoutNotice(text, { title: 'Financial Results for the Quater Ended' })).toBeNull();
  });
});
