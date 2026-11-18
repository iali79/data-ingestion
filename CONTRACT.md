# Ingest API contract

Wire format between this extractor and the ingest API. `src/contract.ts` is the typed version;
the API validates every field again on its side — unknown fields are dropped, enums are closed
lists, and anything outside the limits below is rejected.

Current versions: `schemaVersion` **2** for financial statements and **1** for corporate-action
notices; `extractorVersion` **10**.

## Authentication

Every request carries `Authorization: Bearer <GitHub OIDC token>` issued to this repository's
`extract.yml` workflow on `main`, for a `schedule` or `workflow_dispatch` event. There are no
stored credentials. Any authentication failure is a bare `401`/`403`.

## 1. Claim a task — `POST /api/v1/internal/extraction/claim`

```json
{ "kinds": ["financial_statement", "corporate_action_notice", "market_document"], "extractorVersion": 2 }
```

`200` with one task, or `{ "data": { "task": null } }` when there is nothing to do. Every
response body is wrapped in `data`:

```json
{
  "data": {
    "task": {
      "id": "48213",
      "kind": "financial_statement",
      "sourceUrl": "https://financials.psx.com.pk/lib/DownloadPDF.php?id=272758",
      "context": { "symbol": "HPL", "reportType": "annual", "periodEnded": "2025" },
      "leaseToken": "<64 hex characters>",
      "leaseExpiresAt": "2026-09-23T10:30:00.000Z"
    }
  }
}
```

- `reportType`: `annual | quarterly | half_yearly`
- For `corporate_action_notice`, `context` is `{ "symbol", "title", "publishedAt" }` and
  `sourceUrl` may be `null` (the notice is parsed from its title alone).
- A notice filed as scanned pages instead of a PDF has `sourceUrl` on its first page
  (`https://dps.psx.com.pk/download/image/<post>-1.gif`) and, when it has more than one, `context.imageUrls`:
  every page in order, starting with `sourceUrl`. Each page is read as an image (enlarged, OCR'd word by
  word, lines rebuilt from the word boxes: `extractImage` in `src/extraction.ts`) and the pages are joined.
- `sourceUrl` is always `https` on `financials.psx.com.pk` or `dps.psx.com.pk`; the extractor
  refuses anything else (`host_not_allowed`).
- The lease lasts 30 minutes. The token authorises submitting a result for this one task only.
- A `financial_statement` context may also carry `hints`, set by a reviewer for that filing:
  `{ "unitScale": 1000, "statements": [{ "type": "balance_sheet", "pages": [82], "basis": "unconsolidated" }] }`.
  `unitScale` is 1, 1000 or 1000000; each `statements` entry (at most 6) names a statement type
  (`income_statement`, `balance_sheet`, `cash_flow`), 1 to 6 ascending page numbers and optionally
  a basis. The key is absent when there are no hints. The extractor uses them only when every part
  is well-formed for the document (RULEBOOK.md H0 to H3).

## 2. Submit a result — `POST /api/v1/internal/extraction/results`

### 2a. Financial statement (schema version 2)

The full shape, with every field, is in [FINANCIALS.md](FINANCIALS.md): the envelope (`schemaVersion`
2, `taskId`, `leaseToken`, `extractorVersion`, `outcome`), then `document`, `periods`, `pages` and
`log`. The item keys of each period's `income`, `balance`, `cashFlow` and `ratios` are the closed
lists in [financial-items.json](financial-items.json); a key outside them is a `400`.

Each item is `null`, or one of:

- `{ "value", "source": "reported", "page", "text", "checks" }` — read from the filing;
- `{ "value", "source": "derived", "formula" }` — calculated from reported figures;
- `{ "value": 0, "source": "runtime", "formula" }` — market-based, calculated by the server from the
  day's close. Never stored as a figure.

What the API does again on its side, whatever the payload says:

- The filing's identity (company, period, document) comes from the task, never the payload.
- Every value must be finite and within ±1e15; a period must end within 18 months of the filing's.
- The accounting identities (revenue − cost of sales = gross profit, profit before tax − taxation =
  profit after tax, current + non-current assets = total assets, operating + investing + financing =
  net change in cash, opening + change = closing cash) and every derived formula are recomputed. A
  group that fails is dropped, and the drop is logged.

### 2b. Corporate-action notice

```json
{
  "schemaVersion": 1,
  "taskId": "90117",
  "leaseToken": "<same token>",
  "extractorVersion": 2,
  "outcome": "extracted",
  "document": { "kind": "pdf", "contentType": "application/pdf", "method": "pdftotext", "pageCount": 2, "confidence": 0.9 },
  "corporateActions": [
    {
      "actionType": "dividend",
      "exDate": "2026-09-05",
      "details": { "dividendPercent": 20 },
      "confidence": 0.82,
      "sourceText": "Cash dividend 20% ... Ex-date 05 Sep 2026"
    }
  ]
}
```

- `document` is `null` when the notice had no attachment or it could not be downloaded.
- `actionType`: `dividend | bonus | right | split`. `details` has exactly one key for the type:
  `dividendPercent`, `bonusPercent`, `rightPercent` (0–10,000) or `splitRatio` (`N:N`).
- `exDate` is `YYYY-MM-DD` or `null`. The event date is taken from the notice itself, not sent.
- `meeting` is sent for a notice whose title is a board meeting, read from the document
  (`src/meeting.ts`); `null` otherwise, or when the document states no date clearly:

```json
"meeting": {
  "kind": "board_meeting",
  "date": "2026-10-19",
  "time": "09:30",
  "purpose": "financial_results",
  "resultsPeriod": "quarter",
  "periodEnded": "2026-09-30",
  "confidence": 0.8,
  "sourceText": "meeting of the Board of Directors ... will be held on Monday, October 19, 2026 at 9:30 a.m. ..."
}
```

  `date` is the meeting's local calendar day, `time` local `HH:MM` (24-hour) or `null`;
  `purpose` is `financial_results | other`; `resultsPeriod` is `quarter | half_year | annual` or
  `null`; `periodEnded` is the `YYYY-MM-DD` the results cover, or `null`. The receiving side checks
  the date against the notice's publish date and drops one that cannot be its meeting.

- `insiderTransactions` is sent for a notice titled as a disclosure of interest (PSX Regulation
  5.6.4: a director, executive or substantial shareholder dealt in the company's shares), read from the
  table in the document (`src/insider.ts`); absent for any other notice, and `[]` when the table could
  not be read. A row is never guessed: it has a person, a date, a nature and a quantity, or it is left out.

```json
"insiderTransactions": [
  { "date": "2026-02-04", "person": "Zara Example", "designation": "Elected Director", "nature": "buy",
    "quantity": 27500, "rate": 39.36, "market": "Ready", "cumulativeShares": 1490772, "cumulativePercent": 2,
    "confidence": 0.9, "sourceText": "Zara Example CDC Ready 04-02-2026 Buy 27,500 39.36 1,490,772 2.00 | (Elected Director)" }
]
```

  `date` is the day of the trade (`YYYY-MM-DD`), `nature` is `buy | sell | other`, `quantity` a positive
  whole number of shares, `rate` the price per share or `null`; `cumulativeShares` and `cumulativePercent`
  are the person's holding after the trade, or `null`. The receiving side checks every row against the
  notice's publish date and drops one dated in the future or long before it.

- `payout` is sent for a notice titled as results, a dividend or a book closure (`src/payout.ts`):
  what the Board declared and when the share register closes, read from the covering letter
  (the first three pages; scanned pages are OCR'd). `null` when the notice declares no entitlement;
  absent for any other notice.

```json
"payout": {
  "periodEnded": "2019-06-30",
  "resultsPeriod": "annual",
  "instalment": "final",
  "cashPercent": 65,
  "cashPerShare": null,
  "bonusPercent": 0,
  "rightPercent": 0,
  "bookClosureFrom": "2019-09-13",
  "bookClosureTo": "2019-09-27",
  "confidence": 0.85,
  "sourceText": "Cash Dividend 65% (ii) Bonus Shares Nil (iii) Right Shares Nil ..."
}
```

  Percentages are of face value, as PSX states them, 0 to 10,000; `0` is a stated "Nil", `null`
  not stated. `cashPerShare` is rupees per share when the notice gives it. Dates are `YYYY-MM-DD`
  or `null`; `resultsPeriod` is `quarter | half_year | annual` and `instalment` `final | interim`,
  each or `null`. The ex-date is not in the notice and is not sent: the receiving side derives
  it, and only stages the payout until an operator applies it.

### 2c. Market document

A `market_document` task is one public document, read into rows. Its claim has `context: { "dataset": "ogra-prices" | "pcga-cotton" | "sbp-credit" | "psx-off-market" }` and a `sourceUrl` on one of the
allowed hosts (`www.ogra.org.pk`, `www.pcga.org`, `www.sbp.org.pk`, `dps.psx.com.pk`). The new hosts are fetched under an honest
`CapitalistExtractor/1.0` user agent. **Deploy the API before this extractor runs**: an API that does not know the kind rejects the claim.

```json
{
  "schemaVersion": 1, "taskId": "9021", "leaseToken": "<64 hex>", "extractorVersion": 11, "outcome": "extracted",
  "document": { "kind": "pdf", "contentType": "application/pdf", "method": "pdftotext", "pageCount": 2, "confidence": 0.85 },
  "marketDocument": {
    "dataset": "ogra-prices",
    "asOf": "2026-11-17",
    "rows": [ { "product": "MS", "component": "retail", "value": 328 } ],
    "checks": [ { "id": "MS:retail", "ok": true } ]
  }
}
```

- `rows` holds at most 5000 objects of string, number or null values; the shape depends on the dataset:
  - `ogra-prices`: `{ product: "MS" | "HSD", component, value }` (rupees per litre, or USD per barrel for the crude rows).
  - `pcga-cotton`: `{ region: "punjab" | "sindh" | "pakistan", district, arrivals, pressed, soldTcp, soldExporters, soldTextiles, soldTotal, unsold, unginned, lastYearArrivals, flow, factories, season }` (bales).
  - `sbp-credit`: `{ series, period, value }`, month-end outstanding in million rupees.
  - `psx-off-market`: `{ section: "m2m" | "c2c", rowNo, buyerCode, sellerCode, memberCode, company, shares, rate, value }`.
- `checks` lists every arithmetic identity the parser ran (a printed total against its parts). **`rows` is empty whenever a check
  failed**: a document that does not add up is delivered as nothing, with the failed checks named. The API treats an empty result
  with a failed check as a rejection and keeps the reason; it does not retry a download that cannot change.
  - One exception, `ogra-prices` only: a failed check may carry `"advisory": true`. It means the crude build-up (benchmark to
    ex-refinery price) does not add up in OGRA's own table; the build-up rows are left out and the pump-price chain is delivered.
    OGRA's 12-19 August 2026 diesel tables are the example.
  - Checks whose id starts `sanity:` follow the parser's own, and need only the document: the as-of date lies between
    2010-01-01 and two days after the run; OGRA prints both products with a pump price of Rs 50 to 1,000; each PCGA row holds
    sold = TCP + exporters + textiles, unsold = pressed − sold and unginned = arrivals − pressed, and its date falls in the printed
    season (June to May). A failed one empties `rows` like any other. `sanity:weekday` (an off-market report dated on a weekend)
    is the one advisory check: reported, rows still delivered.
- The API validates every row again against its dataset's closed lists and re-adds the same totals before writing, and
  compares the document with the figures it already holds; one that disagrees is held for review rather than written.

### 2c. Failure

```json
{
  "schemaVersion": 2, "taskId": "48213", "leaseToken": "<same token>", "extractorVersion": 4,
  "outcome": "failed",
  "error": { "code": "download_failed", "message": "download failed with HTTP 503" }
}
```

`code`: `download_failed | document_too_large | unsupported_type | extract_failed |
host_not_allowed`.

### Responses

| Status | Meaning |
|---|---|
| `202` | `{ "data": { "accepted": true } }` — resubmitting the same result is also `202` |
| `401` / `403` | identity not accepted — the run stops |
| `409` | lease not held (expired, superseded or unknown) — the task is skipped |
| `400` | payload failed validation — nothing was stored |

## Limits

| Field | Limit |
|---|---|
| `periods` | 40 |
| `log.drops` | 200 |
| `pages` | 150 (pages cited by a line are kept first) |
| `pages[].text` | 20,000 characters |
| `label` | 160 characters |
| `sourceText` | 1,000 (statement lines), 300 (corporate actions) |
| `corporateActions` | 10 |
| `insiderTransactions` | 60 |
| `error.message` | 500 characters |
| request body | 8 MB |
